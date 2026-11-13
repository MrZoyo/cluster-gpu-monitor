# v0.6.7：备份前检查磁盘空间，清理自己的临时文件

2026-11-13 发布。

本版加固本地 SQLite 备份。此前备份不检查空间就开始写整库副本：磁盘将满时每次都先把磁盘写满再
失败，期间可能影响正在写库的采集器；每次备份还会在目录里留下几个无主的小文件。以下清理都是尽力而为：
权限或 I/O 错误、进程被强制终止时仍可能留下文件，但不会因此让已完成的备份报错。

- **写入前检查空间**：需要数据库与 WAL 之和，再加 20%、至少额外 256 MiB。空间不足时以 `ENOSPC`
  报错退出，不创建备份文件，也不清理旧备份。这是即时检查，不预留空间；磁盘很小的部署可能需要先
  腾出空间。
- **清理自己的临时文件**：源库为 WAL 模式时，副本自检会在临时名旁留下空的 `-wal` / `-shm`，失败的备份
  留下 `-journal`。现在发布前和失败时都会尽力清掉；临时副本的 WAL 若意外有内容则拒绝发布。
- **清理以往残留**：`gpumon backup` 完成后尝试清掉备份目录中无主的伴生文件，只删超过一天未改动、且
  主文件确已不存在的。数据库主文件从不因此被删除，包括被中断的备份留下的临时副本；这类文件超过
  一天未更新时，命令会列出其中符合本功能命名规则的普通文件，供操作者核对。显式指定给 `backup_database()` 的其他目录不做清理。
- **轮换**：清理旧的每日备份时尝试一并删除它旁边的伴生文件。

`keep_count` 轮换的是备份目录中文件名匹配 `gpumon_*.db` 的备份，也就是每日备份。部署或维护脚本调用
`backup_database()` 时若使用不以 `gpumon_` 开头的前缀（例如发布前备份），生成的文件不在轮换范围内，
需要由调用方自行限制数量，否则会一直累积；以 `gpumon_` 开头的自定义前缀若写入同一目录，则会被
一并计数和轮换。

详见[配置参考](CONFIGURATION.md)的备份一节。本版没有数据库结构变化，不涉及 PAI 采集与页面，
第三方依赖保持原锁定版本；同步包版本、锁文件中的本包版本、README 徽章与文档入口。
这是后端变更，生效需要按后端流程升级；发布标签不会自动升级生产实例。

## English

Released on 2026-11-13.

This release hardens the local SQLite backup. A backup used to start writing its whole-database
copy without checking for room: on a nearly full disk every run filled the disk before failing,
which could disturb the running collectors, and each run left a few orphaned small files behind.
All cleanup below is best effort: permission or I/O errors, or a killed process, can still leave
files, but never turn a completed backup into an error.

- **Space check before writing:** the copy needs the database plus its WAL, plus 20% and at least
  256 MiB of extra headroom. Without it the backup fails with `ENOSPC`, creates no backup file and
  prunes nothing. The check is point-in-time and reserves nothing; deployments on very small
  disks may need to free space first.
- **Cleaning up its own temporary files:** for a WAL-mode source, checking the copy leaves empty
  `-wal` / `-shm` files next to its temporary name, and a failed copy leaves a `-journal`. They
  are now removed on a best-effort basis before publishing and on failure; a temporary copy whose
  WAL unexpectedly holds content is not published.
- **Tidying earlier leftovers:** after `gpumon backup`, the command tries to remove orphaned
  sidecar files in the backup directory, but only those unchanged for more than a day whose main file is
  confirmed missing. A database main file is never deleted this way, including temporary copies
  left by an interrupted backup; when such a copy has not changed for more than a day the command
  lists it for an operator, limited to plain files that carry this feature's own names. Directories passed explicitly to `backup_database()` are not tidied.
- **Rotation:** pruning an old daily backup also tries to remove the sidecar files next to it.

`keep_count` rotates the files in the backup directory whose names match `gpumon_*.db`, that is,
the daily backups. Backups that deployment or maintenance scripts create through
`backup_database()` with a prefix that does not start with `gpumon_`, such as pre-release backups,
are outside that rotation; the caller must limit how many it keeps, or they accumulate forever.
A custom prefix that does start with `gpumon_`, written to the same directory, is counted and
rotated together with the daily backups.

See the backup section of the [configuration reference](CONFIGURATION.en.md). There is no
database schema change, nothing changes in PAI collection or pages, and third-party dependencies
retain their locked versions. Package metadata, the local package entry in the lockfile, README
badges and documentation links advance to v0.6.7. This is a backend change and takes effect
through a backend upgrade; publishing a tag does not upgrade production instances.
