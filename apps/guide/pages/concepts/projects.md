# Projects

A Project is a directory you ran Claude Code in. MaxPrice takes each directory's path from the session logs, then folds a repository's worktrees and its checkouts on other machines into one Project, so the Projects page shows a row per piece of work rather than per folder.

## Worktrees

A worktree Claude Code makes sits under the project's `.claude/worktrees/` directory. MaxPrice folds it into its project by its path alone, so the fold holds after the worktree is deleted. In Projects a project with more than one directory gets a chevron that expands it into one row per directory.

## Repo identity

Checkouts of one Git repository fold into one Project too, on this machine or on others. MaxPrice reads each checkout's `origin` remote from its `.git` folder; it never runs Git. A checkout's Repo identity is that remote plus the checkout's place inside the repository, and two checkouts with the same Repo identity fold. An SSH and an HTTPS address for the same remote count as the same. A repository with no remote folds with nothing.

MaxPrice remembers each checkout's remote, so a fold holds after the checkout is deleted. Folding with another machine's checkouts needs a [Hub](hubs.md) with **Share usage events** and **Fleet replica** on.

## Merging projects

When two Projects are the same work but don't fold by themselves, such as a repository that was renamed or one with no remote, merge them by hand. In Projects, choose a row's **Merge project history** button, pick the project to keep under **Merge into**, and choose **Merge projects**, then **Click again to merge** to confirm. The merged row then carries a **Manual merge** pill.

To undo a merge, open **Manage merges**, which shows once any merge exists, and choose **Unmerge** on it. A merge changes no files or session logs. With a Hub, merges apply on every machine.

## Stale projects

A project with no activity for 90 days or more is dimmed. It is never hidden or moved: it shows only while the Date range reaches back to its last activity.

## Projects and the Date range

Every number in Projects answers the Date range: its cost, its tokens, its sessions and its last activity. The one exception is when a project was **first seen**, which is the first day of its usage ever.
