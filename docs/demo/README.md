# README 演示数据与截图

截图是当前前端在隔离数据库中的实际页面，不是设计稿。截图文件位于 `docs/images/`，公开 README 使用相对路径引用，无需外部图床。

## 数据范围

`seed.mjs` 从零编写以下合成内容，不读取或复制本地客户资料：

- 6 个虚构公司：星澜智造、云岑供应链、沐川数科、栖原新材、知屿商贸、晴序科技。名称仅作为虚构示例，不指向现实机构。
- 3 个通用演示项目、8 条售后工单、6 条知识记录。
- 1 段人工编写的排查对话，包含示例工具调用与结果，不调用任何真实模型或客户环境。
- 使用团队角色作为处理人，不使用真实姓名、电话或邮箱。
- IP 使用 `192.0.2.0/24` 文档示例网段；Git 和模型地址使用 `example.com` 子域名，路径统一为 `/srv/demo/`。
- 不写入真实 API Key、Git Token、SSH 私钥、客户日志或附件。

该脚本不参与正式部署初始化，正式启动仍使用 `server/src/db/seed.ts`。模型配置只是展示占位项，没有真实 API Key，不能用于实际排查。截图中的同步状态也是演示数据，不代表已拉取仓库。

## 重建独立演示环境

需要 Node.js 22、Docker 和已安装的前后端依赖。以下命令从源码仓库根目录执行，端口 16489、18089 需空闲；不要使用已有业务数据库或数据目录。

```bash
export DATABASE_URL='postgres://postgres:readme_local_only@127.0.0.1:16489/aftersale_readme'
export DATA_ROOT=/tmp/aftersale-readme-demo
export ADMIN_PASSWORD="$(openssl rand -hex 16)"
export PORT=18089

docker run -d --name aftersale-readme-db \
  -e POSTGRES_PASSWORD=readme_local_only \
  -e POSTGRES_DB=aftersale_readme \
  -p 127.0.0.1:16489:5432 pgvector/pgvector:pg16
# 等待下面命令返回 accepting connections
docker exec aftersale-readme-db pg_isready -U postgres

npm --prefix server ci
npm --prefix web ci
server/node_modules/.bin/tsx docs/demo/seed.mjs
npm --prefix web run build
npm --prefix server start
```

脚本只接受本地专用数据库名 `aftersale_readme`、末级名为 `aftersale-readme-demo` 的显式数据目录，并拒绝已有表的数据库。先执行演示脚本再启动应用，避免默认初始化加入其他样例数据。

在本机访问 <http://localhost:18089>，使用 `admin` 和上面生成的 `ADMIN_PASSWORD` 登录。检查公司、工单与知识全部是上述演示内容后，依次截取：

| 文件 | 页面 |
| --- | --- |
| `docs/images/workbench.jpg` | 第一条工单的排查工作区 |
| `docs/images/records.jpg` | 售后记录列表 |
| `docs/images/customers.jpg` | 客户信息列表 |
| `docs/images/knowledge.jpg` | 知识沉淀列表 |

截图前关闭提示浮层，核对每张截图中的公司、地址、问题内容与处理人。不要从已连接真实业务环境的浏览器页面截图，也不要用真实客户数据替换展示样例。

完成后停止演示应用，移除本次专用容器及其临时卷：

```bash
docker rm -f -v aftersale-readme-db
```

演示运行目录不会随源码发布，需要时可另行清理专用的 `/tmp/aftersale-readme-demo`。
