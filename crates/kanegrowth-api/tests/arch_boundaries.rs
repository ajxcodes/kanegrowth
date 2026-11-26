use std::fs;

#[test]
fn domain_has_no_db_or_http_deps() {
    for path in [
        "src/entity_map.rs",
        "src/models.rs",
        "src/util.rs",
        "src/config.rs",
    ] {
        let content = fs::read_to_string(path).unwrap();
        for forbidden in ["rusqlite", "axum", "tokio"] {
            assert!(
                !content.contains(forbidden),
                "{} contains forbidden dep {}",
                path,
                forbidden
            );
        }
    }
}

#[test]
fn no_sql_in_handlers() {
    let content = fs::read_to_string("src/main.rs").unwrap();
    for kw in ["SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
        assert!(!content.contains(kw), "handler contains SQL: {}", kw);
    }
}
