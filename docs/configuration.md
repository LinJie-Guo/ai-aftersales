# 配置与本地开发

## 配置职责

| 类型 | 保存位置 | 用途 |
| --- | --- | --- |
| 数据库连接与端口 | Docker 的 `.env` 或后端进程环境变量 | 确定应用连接哪个数据库、服务使用哪个端口 |
| 管理员与业务账号 | PostgreSQL 的 `app_user` 表 | 由初始化创建，通过用户管理维护；密码保存为 scrypt 哈希 |
| 模型、Git 与客户环境 | 系统设置及客户信息 | 管理业务接入配置与凭据 |

默认管理员为 `admin / admin123`，由 [初始化 SQL](sql/init.sql) 或自动初始化创建。首次登录后在用户管理中修改密码；修改部署 `.env` 不会改变该账号。

## Docker 数据库配置样例

复制 [docs/docker/.env.example](docker/.env.example) 为同目录 `.env`：

```dotenv
DATABASE_HOST=db
DATABASE_PORT=5432
POSTGRES_USER=aftersale
POSTGRES_PASSWORD=aftersale_demo_password_2026
POSTGRES_DB=aftersale
POSTGRES_PORT=5432
APP_PORT=8080
```

这些值可直接用于本地体验；正式部署前替换示例密码。用户名、库名使用字母、数字和下划线；密码使用 URL 安全字符，例如 `openssl rand -hex 24` 的输出。

| 变量 | 说明 |
| --- | --- |
| `DATABASE_HOST` | 应用连接的数据库主机；内置数据库填 `db`，外部数据库填实际 IP 或域名 |
| `DATABASE_PORT` | 应用连接的数据库端口，默认 `5432` |
| `POSTGRES_USER` | PostgreSQL 用户名；已有卷需填写实际用户 |
| `POSTGRES_PASSWORD` | PostgreSQL 用户密码，同时用于应用连接 |
| `POSTGRES_DB` | 数据库名称 |
| `POSTGRES_PORT` | 数据库映射到宿主机的端口 |
| `APP_PORT` | 应用映射到宿主机的端口 |

按上述样例启动时，应用容器使用 `postgres://aftersale:aftersale_demo_password_2026@db:5432/aftersale`。容器之间通过服务名 `db` 连接，**不使用宿主机映射端口**。本地数据库客户端则连接 `localhost:5432`。

连接外部数据库时，将 `DATABASE_HOST` 改为实际 IP 或域名，并填写对应的端口、用户名、密码及库名。例如：

```dotenv
DATABASE_HOST=192.0.2.10
DATABASE_PORT=5432
POSTGRES_USER=aftersale_user
POSTGRES_PASSWORD=example_password
POSTGRES_DB=aftersale
APP_PORT=8080
```

以上 IP 和密码仅作格式示例。使用外部数据库可执行 `docker compose -f docs/docker/docker-compose.yml up -d --build --no-deps app`，仅启动应用；需提前准备可访问的数据库，应用会自动建表。不要在应用容器中用 `localhost` 指代另一台服务器或数据库容器。

修改这些值不会修改已有数据库卷中的用户、库或密码。已有环境应与实际数据库保持一致；密码变更需同时更新数据库用户密码和应用配置。

## 本地后端数据库连接样例

复制 [server/.env.example](../server/.env.example) 为 `server/.env`：

```dotenv
DATABASE_URL=postgres://aftersale:aftersale_demo_password_2026@localhost:5432/aftersale
PORT=8080
```

自建 PostgreSQL 的配置形式如下，替换示例地址及连接信息后使用：

```dotenv
DATABASE_URL=postgres://aftersale_user:example_password@192.0.2.10:5432/aftersale
PORT=8080
```

`192.0.2.10` 是文档示例地址，不能直接连接。若密码包含 URL 保留字符，连接串中的密码部分需要做百分号编码。

后端不会自动加载 `.env`。使用下面开发命令的 `--env-file` 参数加载；Docker Compose 则自动读取 `docs/docker/.env`，并将 Compose 声明的变量传入容器。

## 其他运行变量

| 变量 | 默认值 / 用途 |
| --- | --- |
| `DATABASE_URL` | 未设置时为 `postgres://aftersale:aftersale_demo_password_2026@localhost:5432/aftersale` |
| `DATA_ROOT` | 源码仓库外的 `../data`；容器内为 `/data/aftersale` |
| `PORT` | 后端监听 `8080`；Compose 的 `APP_PORT` 只改变宿主机映射 |
| `WEB_DIST` | `web/dist` 的绝对路径 |
| `APP_NAME` | `AI 售后系统` |
| `JWT_SECRET` | 未设置时使用 `DATA_ROOT/_secrets.json` 中的随机值 |
| `SECRET_ENCRYPTION_KEY` | 未设置时使用上述文件中的加密密钥；更换会影响已有凭据解密 |
| `JWT_EXPIRE_MINUTES` | `1440` |
| `SSH_DEFAULT_USER` | `aftersale` |
| `SSH_PRIVATE_KEY_PATH` | 空；备用 SSH 私钥文件路径，容器使用时需挂载对应文件 |
| `VITE_API_TARGET` | 前端开发代理目标，默认 `http://localhost:8080` |

其他后端变量需显式加入 Compose 的 `app.environment` 才会传入容器。即使设置密钥环境变量，应用仍会创建并读取本地密钥文件，因此 `DATA_ROOT` 必须可写。

兼容旧部署：`seed.ts` 仍支持通过进程变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 覆盖空库自动初始化的账号，默认分别为 `admin` / `admin123`。这两项是初始化参数，不列入标准部署样例；不会覆盖已有 scrypt 密码，手动 SQL 初始化也不读取它们。

## 本地开发

准备 Node.js 22、npm、PostgreSQL 16，以及 Git、OpenSSH、ripgrep；PDF 文本提取还需要 Poppler。从仓库根目录执行：

```bash
cp docs/docker/.env.example docs/docker/.env
cp server/.env.example server/.env
# 若修改数据库连接信息，请同步更新两个文件
docker compose -f docs/docker/docker-compose.yml up -d db
npm --prefix server ci
npm --prefix web ci
```

终端一启动后端并加载配置：

```bash
cd server
node --env-file=.env --import tsx --watch src/index.ts
```

终端二从仓库根目录执行 `npm --prefix web run dev`，访问 <http://localhost:5173>。后端启动自动执行迁移和初始化。开发后端与容器应用不要同时操作同一套业务数据。

## 验证

```bash
npm --prefix server run typecheck
DATA_ROOT=/tmp/aftersale-tests npm --prefix server test
npm --prefix web run typecheck
npm --prefix web run build
```

Docker 镜像构建会执行类型检查、后端测试和前端构建。`server/scripts/` 中的模型评测与容器 smoke 脚本可能调用模型并创建测试数据，仅对隔离测试环境运行。
