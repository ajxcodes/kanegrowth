use crate::db::Db;
use crate::models::WorkspaceDto;
use crate::util::now_iso;
use rusqlite::params;
use uuid::Uuid;

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
    Ok(WorkspaceDto {
        id,
        name: name.to_string(),
        owner_user_id: user_id.to_string(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn list_workspaces(db: &Db, user_id: &str) -> Result<Vec<WorkspaceDto>, String> {
    let conn = crate::db::conn(db);
    let mut stmt = conn
        .prepare("SELECT w.id, w.name, w.owner_user_id, w.created_at, w.updated_at FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![user_id], |r| {
            Ok(WorkspaceDto {
                id: r.get(0)?,
                name: r.get(1)?,
                owner_user_id: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
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
    let row = conn
        .query_row(
            "SELECT id, name, owner_user_id, created_at, updated_at FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |r| {
                Ok(WorkspaceDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    owner_user_id: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(row)
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
    let conn = crate::db::conn(db);
    let now = now_iso();
    conn.execute(
        "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now, workspace_id],
    )
    .map_err(|e| e.to_string())?;
    get_workspace(db, workspace_id, user_id)
}
