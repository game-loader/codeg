//! Pure, conservative source identity derivation. Raw remotes stay internal.

use crate::models::folder::{RepositoryProjectIdentity, RepositoryProjectProvider};

pub(crate) fn normalize_remote(remote: &str, name: &str) -> Option<RepositoryProjectIdentity> {
    if remote
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return None;
    }
    let url_text = if remote.contains("://") {
        remote.to_owned()
    } else {
        let (authority, path) = remote.split_once(':')?;
        // scp syntax must identify a network host, never a drive or local path.
        if authority.contains('/') || authority.len() == 1 {
            return None;
        }
        let path = path.strip_prefix('/').unwrap_or(path);
        format!("ssh://{authority}/{path}")
    };
    // Validate before URL parsing: WHATWG parsing erases dot segments.
    // Query/fragment slashes cannot supply a missing repository path.
    let raw_path = url_text
        .split(['?', '#'])
        .next()?
        .split_once("://")?
        .1
        .split_once('/')?
        .1;
    let repository_path = raw_path
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(raw_path.trim_end_matches('/'));
    if repository_path.is_empty()
        || repository_path.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.~".contains(&c))
        })
    {
        return None;
    }
    let url = url::Url::parse(&url_text).ok()?;
    let default_port = match url.scheme() {
        "http" => 80,
        "https" => 443,
        "ssh" => 22,
        _ => return None,
    };
    let mut host = url.host_str()?.to_ascii_lowercase();
    if url.scheme() == "ssh" && !host.contains('.') && !host.contains(':') {
        return None; // An unverified machine-local SSH alias is not a source identity.
    }
    let port = url.port().filter(|port| *port != default_port);
    let github = (host == "github.com" && port.is_none())
        || (host == "ssh.github.com"
            && url.scheme() == "ssh"
            && (port.is_none() || port == Some(443)));
    let (provider, repository_path, project_key) = if github {
        if repository_path.split('/').count() != 2 {
            return None;
        }
        host = "github.com".to_owned();
        let path = repository_path.to_ascii_lowercase();
        let key = format!("github:{path}");
        (RepositoryProjectProvider::Github, path, key)
    } else {
        if let Some(port) = port {
            host = format!("{host}:{port}");
        }
        (
            RepositoryProjectProvider::Git,
            repository_path.to_owned(),
            format!("git:{host}/{repository_path}"),
        )
    };
    Some(RepositoryProjectIdentity {
        project_key,
        provider,
        host,
        repository_path,
        remote_name: name.to_owned(),
    })
}

pub(crate) fn fetch_remotes(output: &str) -> Vec<(&str, &str)> {
    output
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once('\t')?;
            let (url, annotation) = rest.split_once(" (fetch)")?;
            let annotation = annotation.trim();
            if name.is_empty()
                || name.chars().any(char::is_control)
                || (!annotation.is_empty()
                    && !(annotation.starts_with('[') && annotation.ends_with(']')))
            {
                return None;
            }
            Some((name, url))
        })
        .collect()
}

pub(crate) fn select_identity(output: &str) -> Option<RepositoryProjectIdentity> {
    let mut remotes = fetch_remotes(output);
    // Stable sorting retains the first usable URL within a remote.
    remotes.sort_by_key(|(name, _)| {
        (
            match *name {
                "upstream" => 0,
                "origin" => 1,
                _ => 2,
            },
            *name,
        )
    });
    remotes
        .into_iter()
        .find_map(|(name, remote)| normalize_remote(remote, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize(remote: &str) -> Option<RepositoryProjectIdentity> {
        normalize_remote(remote, "origin")
    }

    #[test]
    fn github_transports_casing_and_documented_alias_match() {
        assert_eq!(
            normalize("git@github.com:Someone/Foo.git")
                .unwrap()
                .project_key,
            "github:someone/foo"
        );
        assert_eq!(
            normalize("https://github.com/someone/foo.git")
                .unwrap()
                .project_key,
            "github:someone/foo"
        );
        assert_eq!(
            normalize("ssh://git@ssh.github.com:443/someone/foo.git")
                .unwrap()
                .project_key,
            "github:someone/foo"
        );
        for remote in [
            "http://GITHUB.COM/Someone/Foo/",
            "ssh://git@github.com:22/Someone/Foo.git",
        ] {
            let identity = normalize(remote).unwrap();
            assert_eq!(identity.project_key, "github:someone/foo");
            assert_eq!(identity.host, "github.com");
            assert_eq!(identity.repository_path, "someone/foo");
        }
    }

    #[test]
    fn aliases_local_paths_and_invalid_network_paths_are_excluded() {
        assert!(normalize("git@github-work:someone/foo.git").is_none());
        assert!(normalize("file:///home/me/foo").is_none());
        for remote in [
            "/home/me/foo",
            "../foo",
            "C:/foo",
            "ssh://git@github-work/someone/foo",
            "ftp://example.com/team/foo",
            "https://github.com/foo",
            "https://github.com/",
            "https://git.example.com/team/../foo",
            "https://git.example.com/team//foo",
            "https://git.example.com/team/foo\n",
        ] {
            assert!(normalize(remote).is_none(), "accepted invalid remote");
        }
    }

    #[test]
    fn generic_paths_enterprise_hosts_and_nondefault_ports_stay_distinct() {
        assert_ne!(
            normalize("https://git.example.com/Team/Foo.git"),
            normalize("https://git.example.com/team/foo.git")
        );
        let generic = normalize("https://git.example.com/Team/Foo.git").unwrap();
        assert_eq!(generic.project_key, "git:git.example.com/Team/Foo");
        assert_ne!(
            generic.project_key,
            normalize("https://git.other.example/Team/Foo.git")
                .unwrap()
                .project_key
        );
        assert_ne!(
            generic.project_key,
            normalize("https://git.example.com:8443/Team/Foo.git")
                .unwrap()
                .project_key
        );
        assert_eq!(
            generic.project_key,
            normalize("ssh://git@git.example.com:22/Team/Foo.git")
                .unwrap()
                .project_key
        );
        assert_ne!(
            normalize("https://github.com:8443/team/foo")
                .unwrap()
                .project_key,
            "github:team/foo"
        );
        assert_ne!(
            normalize("https://github.enterprise.one/team/foo")
                .unwrap()
                .project_key,
            normalize("https://github.enterprise.two/team/foo")
                .unwrap()
                .project_key
        );
    }

    #[test]
    fn credentials_query_and_fragment_never_enter_safe_identity() {
        let identity = normalize(
            "https://user:TOP_SECRET@github.com/Someone/Foo.git?token=QUERY_SECRET#FRAGMENT_SECRET",
        )
        .unwrap();
        assert_eq!(
            identity,
            normalize("git@github.com:someone/foo.git").unwrap()
        );
        let wire = serde_json::to_string(&identity).unwrap();
        for secret in [
            "user",
            "TOP_SECRET",
            "QUERY_SECRET",
            "FRAGMENT_SECRET",
            "https://",
            "git@",
        ] {
            assert!(!wire.contains(secret));
        }
    }

    #[test]
    fn pathless_query_and_fragment_are_not_repository_paths() {
        for scheme in ["http", "https", "ssh"] {
            for host in ["git.example.com", "github.com"] {
                for suffix in [
                    "?access_token=/QUERY_SECRET/Repo.git",
                    "#access_token=/FRAGMENT_SECRET/Repo.git",
                    "?access_token=QUERY_SECRET#access_token=/FRAGMENT_SECRET/Repo.git",
                ] {
                    let remote =
                        format!("{scheme}://USERNAME_SECRET:PASSWORD_SECRET@{host}{suffix}");
                    assert!(normalize(&remote).is_none(), "accepted a pathless remote");
                }
            }
        }
        let identity = normalize(
            "https://USERNAME_SECRET:PASSWORD_SECRET@git.example.com/Team/Repo.git?access_token=/QUERY_SECRET/Other.git#access_token=/FRAGMENT_SECRET/Other.git",
        )
        .unwrap();
        assert_eq!(
            identity,
            normalize("https://git.example.com/Team/Repo.git").unwrap()
        );
        let wire = serde_json::to_string(&identity).unwrap();
        for secret in [
            "USERNAME_SECRET",
            "PASSWORD_SECRET",
            "QUERY_SECRET",
            "FRAGMENT_SECRET",
            "access_token",
        ] {
            assert!(!wire.contains(secret));
        }
    }

    #[test]
    fn pathless_upstream_query_and_fragment_fall_back_to_origin() {
        for suffix in [
            "?access_token=/QUERY_SECRET/Repo.git",
            "#access_token=/FRAGMENT_SECRET/Repo.git",
        ] {
            let output = format!(
                "upstream\thttps://USERNAME_SECRET:PASSWORD_SECRET@git.example.com{suffix} (fetch)\norigin\thttps://git.example.com/Team/Repo.git (fetch)\n"
            );
            let identity = select_identity(&output).unwrap();
            assert_eq!(
                identity,
                normalize("https://git.example.com/Team/Repo.git").unwrap()
            );
        }
    }

    #[test]
    fn absolute_scp_network_paths_match_ssh_urls_and_upstream_wins() {
        let scp = "git@git.example.com:/srv/git/Team/Repo.git";
        let identity = normalize(scp).unwrap();
        assert_eq!(
            identity.project_key,
            "git:git.example.com/srv/git/Team/Repo"
        );
        assert_eq!(
            identity,
            normalize("ssh://git@git.example.com/srv/git/Team/Repo.git").unwrap()
        );
        assert_eq!(
            normalize("git@github.com:/Team/Repo.git"),
            normalize("ssh://git@github.com/Team/Repo.git")
        );
        let output = format!(
            "origin\thttps://git.example.com/Fork/Repo.git (fetch)\nupstream\t{scp} (fetch)\n"
        );
        let selected = select_identity(&output).unwrap();
        assert_eq!(selected.remote_name, "upstream");
        assert_eq!(selected.project_key, identity.project_key);
    }

    #[test]
    fn absolute_scp_paths_preserve_local_alias_and_dot_segment_exclusions() {
        for remote in [
            "/srv/git/Team/Repo.git",
            "file:///srv/git/Team/Repo.git",
            "C:/srv/git/Team/Repo.git",
            "C:\\srv\\git\\Team\\Repo.git",
            "git@github-work:/srv/git/Team/Repo.git",
            "github-work:/srv/git/Team/Repo.git",
            "git@git.example.com:/srv/../Team/Repo.git",
            "git@git.example.com:/srv/./Team/Repo.git",
            "git@git.example.com://srv/git/Team/Repo.git",
            "ssh://git@git.example.com/srv/../Team/Repo.git?token=/QUERY_SECRET",
            "https://git.example.com/Team/./Repo.git#token=/FRAGMENT_SECRET",
        ] {
            assert!(normalize(remote).is_none(), "accepted an invalid remote");
        }
    }

    #[test]
    fn partial_clone_fetch_annotations_and_push_only_rows() {
        let output = "origin\thttps://github.com/team/repo.git (fetch) [blob:none]\norigin\thttps://github.com/private/push.git (push)\npush-only\thttps://github.com/other/push.git (push)\n";
        assert_eq!(
            fetch_remotes(output),
            vec![("origin", "https://github.com/team/repo.git")]
        );
        assert_eq!(
            select_identity(output).unwrap().project_key,
            "github:team/repo"
        );
        assert!(select_identity("origin\thttps://github.com/team/repo.git (push)\n").is_none());
    }

    #[test]
    fn upstream_first_invalid_upstream_falls_back_then_lexical_fetch() {
        let output = "zeta\thttps://github.com/z/repo (fetch)\norigin\thttps://github.com/fork/repo (fetch)\nupstream\thttps://github.com/source/repo (fetch)\nalpha\thttps://github.com/a/repo (fetch)\n";
        let identity = select_identity(output).unwrap();
        assert_eq!(identity.remote_name, "upstream");
        assert_eq!(identity.project_key, "github:source/repo");
        let fallback = output.replace(
            "https://github.com/source/repo",
            "git@github-work:source/repo",
        );
        assert_eq!(select_identity(&fallback).unwrap().remote_name, "origin");
        let lexical = fallback.replace("https://github.com/fork/repo", "/local/repo");
        assert_eq!(select_identity(&lexical).unwrap().remote_name, "alpha");
    }

    #[test]
    fn forks_share_upstream_and_empty_or_unusable_remotes_are_authoritative_null() {
        let left = "origin\thttps://github.com/one/fork (fetch)\nupstream\tgit@github.com:source/repo.git (fetch)\n";
        let right = "origin\thttps://github.com/two/fork (fetch)\nupstream\thttps://github.com/source/repo (fetch)\n";
        assert_eq!(select_identity(left), select_identity(right));
        assert!(select_identity("").is_none());
        assert!(select_identity("origin\t/local/repo (fetch)\n").is_none());
    }
}
