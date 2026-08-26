use std::fs;
use std::path::{Path, PathBuf};

const MAX_RECORDING_DIRECTORY_CHARS: usize = 4096;

pub(crate) fn resolve_custom_recording_directory(
    destination_directory: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(value) = destination_directory else {
        return Ok(None);
    };
    if value.is_empty() || value.chars().all(char::is_whitespace) {
        return Err("自定义记录目录不能为空".to_owned());
    }
    if value.chars().count() > MAX_RECORDING_DIRECTORY_CHARS {
        return Err(format!(
            "自定义记录目录不能超过 {MAX_RECORDING_DIRECTORY_CHARS} 个字符"
        ));
    }

    let path = Path::new(value);
    if !path.is_absolute() {
        return Err("自定义记录目录必须是绝对路径".to_owned());
    }

    let canonical = dunce::canonicalize(path)
        .map_err(|error| format!("无法解析自定义记录目录 {}: {error}", path.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("无法读取自定义记录目录 {}: {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("自定义记录目录不是文件夹: {}", path.display()));
    }
    Ok(Some(canonical))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "vofa-ultra-recording-directory-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn accepts_absent_or_existing_absolute_directory() {
        assert_eq!(resolve_custom_recording_directory(None).unwrap(), None);

        let directory = TestDirectory::new("valid");
        let resolved = resolve_custom_recording_directory(directory.path.to_str()).unwrap();
        assert_eq!(
            resolved,
            Some(dunce::canonicalize(&directory.path).unwrap())
        );

        #[cfg(windows)]
        assert!(!resolved.unwrap().to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn rejects_empty_relative_missing_and_file_paths() {
        assert!(resolve_custom_recording_directory(Some("")).is_err());
        assert!(resolve_custom_recording_directory(Some("   ")).is_err());
        assert!(resolve_custom_recording_directory(Some(
            &"x".repeat(MAX_RECORDING_DIRECTORY_CHARS + 1)
        ))
        .unwrap_err()
        .contains("4096"));
        assert!(resolve_custom_recording_directory(Some("relative/path")).is_err());

        let directory = TestDirectory::new("invalid");
        let missing = directory.path.join("missing");
        assert!(resolve_custom_recording_directory(missing.to_str()).is_err());

        let file = directory.path.join("capture.vucap");
        fs::write(&file, b"existing").unwrap();
        let error = resolve_custom_recording_directory(file.to_str()).unwrap_err();
        assert!(error.contains("不是文件夹"));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_symbolic_link_to_its_existing_target() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new("symlink");
        let target = directory.path.join("target");
        let link = directory.path.join("selected");
        fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let resolved = resolve_custom_recording_directory(link.to_str()).unwrap();
        assert_eq!(resolved, Some(fs::canonicalize(target).unwrap()));
    }
}
