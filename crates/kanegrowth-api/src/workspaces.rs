use crate::db::Db;
use crate::models::{WorkspaceDto, WorkspaceMemberDto};
use crate::util::now_iso;
use rusqlite::params;
use uuid::Uuid;

fn normalise_role(role: &str) -> String {
    match role {
        "owner" => "owner".to_string(),
        "editor" => "editor".to_string(),
        _ => "viewer".to_string(),
    }
}

fn load_members(conn: &rusqlite::Connection, workspace_id: &str) -> Vec<WorkspaceMemberDto> {
    let mut stmt = match conn.prepare(
        "SELECT wm.user_id, wm.role, u.full_name, u.email FROM workspace_members wm \
         LEFT JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ?1 \
         ORDER BY wm.created_at ASC, wm.user_id ASC",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(params![workspace_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|row| row.ok())
        .map(|(user_id, role, full_name, email)| WorkspaceMemberDto {
            user_id,
            role: normalise_role(&role),
            full_name,
            email,
        })
        .collect()
}

fn workspace_dto(
    conn: &rusqlite::Connection,
    id: String,
    name: String,
    owner_id: String,
    created_at: String,
    updated_at: String,
) -> WorkspaceDto {
    let members = load_members(conn, &id);
    WorkspaceDto {
        id,
        name,
        owner_id,
        members,
        created_at,
        updated_at,
    }
}

pub fn create_workspace(db: &Db, user_id: &str, name: &str) -> Result<WorkspaceDto, String> {
    let conn = crate::db::conn(db);
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    conn.execute(
        "INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?1,?2,?3,?4,?4)",
        params![id, name, user_id, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?1,?2,'owner',?3)",
        params![id, user_id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(workspace_dto(
        &conn,
        id,
        name.to_string(),
        user_id.to_string(),
        now.clone(),
        now,
    ))
}

pub fn list_workspaces(db: &Db, user_id: &str) -> Result<Vec<WorkspaceDto>, String> {
    let conn = crate::db::conn(db);
    let rows: Vec<(String, String, String, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT w.id, w.name, w.owner_user_id, w.created_at, w.updated_at FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    Ok(rows
        .into_iter()
        .map(|(id, name, owner_id, created_at, updated_at)| {
            workspace_dto(&conn, id, name, owner_id, created_at, updated_at)
        })
        .collect())
}

pub fn is_member(db: &Db, workspace_id: &str, user_id: &str) -> bool {
    let conn = crate::db::conn(db);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
            params![workspace_id, user_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    count > 0
}

pub fn get_workspace(db: &Db, workspace_id: &str, user_id: &str) -> Result<WorkspaceDto, String> {
    if !is_member(db, workspace_id, user_id) {
        return Err("forbidden".to_string());
    }
    let conn = crate::db::conn(db);
    let (id, name, owner_id, created_at, updated_at): (String, String, String, String, String) =
        conn.query_row(
            "SELECT id, name, owner_user_id, created_at, updated_at FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(workspace_dto(
        &conn, id, name, owner_id, created_at, updated_at,
    ))
}

pub fn update_workspace(
    db: &Db,
    workspace_id: &str,
    user_id: &str,
    name: &str,
) -> Result<WorkspaceDto, String> {
    if !is_member(db, workspace_id, user_id) {
        return Err("forbidden".to_string());
    }
    {
        let conn = crate::db::conn(db);
        let now = now_iso();
        conn.execute(
            "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now, workspace_id],
        )
        .map_err(|e| e.to_string())?;
    }
    get_workspace(db, workspace_id, user_id)
}
