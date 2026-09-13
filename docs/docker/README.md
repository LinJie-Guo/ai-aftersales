# Docker 部署与运维

所有命令在源码仓库根目录执行。需要 Docker Engine 和 Compose v2；数据库使用 PostgreSQL 16，业务镜像包含 Node.js 22、前端和 API，无需额外部署 Python、Redis 或 Nginx。

## 安装与启动

```bash
cp docs/docker/.env.example docs/docker/.env
# 编辑 docs/docker/.env，设置数据库用户名、密码、库名与端口
# 可用 openssl rand -hex 24 生成随机密码
docker compose -f docs/docker/docker-compose.yml up -d --build
docker compose -f docs/docker/docker-compose.yml ps
curl --fail http://localhost:8080/health
```

访问 <http://localhost:8080>，首次使用 `admin / admin123` 登录，并在用户管理中修改密码。首次启动会自动建表、初始化角色、管理员及示例业务数据；无需手工导入 SQL。首次配置见 [使用说明](../usage.md)。

`.env.example` 提供可运行的本地数据库样例：用户 `aftersale`、库 `aftersale`、密码 `aftersale_demo_password_2026`。未配置 `.env` 时数据库密码回退为 `aftersale_demo_password_2026`。示例密码仅用于本地体验，正式部署前须修改。管理员账号属于初始化数据，不放在部署 `.env` 中。数据库密码同时用于连接 URL，应使用字母、数字、下划线和连字符。

| 存储 | 默认位置 |
| --- | --- |
| 数据库 | Docker 命名卷 `aftersale_pgdata` |
| 文件、代码、附件、知识、密钥 | 仓库的兄弟目录 `../data`，挂载到 `/data/aftersale` |
| 本地部署配置 | `docs/docker/.env`，不提交 Git |

相对挂载路径以 Compose 文件所在目录计算，`../../../data` 即仓库外的 `../data`。多个环境应分别配置项目名、端口与挂载位置，避免共用数据。数据库默认映射宿主机 5432，应用映射 8080；正式部署按需限制数据库端口访问，并通过反向代理提供 HTTPS。客户现场数据库和中间件在客户环境中配置，不由此 Compose 创建。

## 日志、更新与停止

```bash
docker compose -f docs/docker/docker-compose.yml logs --tail=100 app db
# 拉取源码新版本后，先备份，再构建并启动
docker compose -f docs/docker/docker-compose.yml up -d --build
# 停止并保留持久化数据
docker compose -f docs/docker/docker-compose.yml down
```

构建会运行前后端类型检查、后端测试和前端打包。应用启动会自动迁移数据库、处理历史密钥、补齐附件归属和知识搜索数据。不要对现有数据库重新导入 `init.sql`。

修改 `.env` 中用户名、库名和密码不会修改已有卷内的数据库用户或库；已有环境应填写实际用户与库名；变更密码时，先在数据库中修改密码，再同步配置并重建应用容器。业务管理员密码通过系统的用户管理修改，应用重启不会重置已有 scrypt 密码。

## 备份与恢复

为获得数据库和文件的一致快照，备份时停止应用写入。以下文件名仅为示例，每次备份使用新的目录：

```bash
mkdir -p backups/pre-upgrade
docker compose -f docs/docker/docker-compose.yml stop app
docker compose -f docs/docker/docker-compose.yml exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/pre-upgrade/database.dump
tar -czf backups/pre-upgrade/data.tar.gz -C .. data
cp docs/docker/.env backups/pre-upgrade/deployment.env
docker compose -f docs/docker/docker-compose.yml start app
```

确认各命令成功并检查备份后再升级，同时记录源码版本或镜像 ID。若使用环境变量覆盖 JWT 或加密密钥，也要安全保存其原值。备份含凭据和客户信息，保存在受控位置，不上传 GitHub。

恢复操作会替换目标库全部数据，仅对已确认的恢复目标执行：

```bash
docker compose -f docs/docker/docker-compose.yml stop app
docker compose -f docs/docker/docker-compose.yml exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"'
docker compose -f docs/docker/docker-compose.yml exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose -f docs/docker/docker-compose.yml exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' < backups/pre-upgrade/database.dump
# 先将现有 ../data 移到一个新的安全位置，再解压匹配备份，避免混入旧文件
tar -xzf backups/pre-upgrade/data.tar.gz -C ..
# 恢复匹配的部署配置和应用版本后再启动
docker compose -f docs/docker/docker-compose.yml up -d app
```

恢复前后均检查日志与健康接口。回退需恢复匹配的数据库、文件、密钥及应用版本。不要删除 `data/_secrets.json`；不要执行 `docker compose down -v`，它会删除数据库卷。
