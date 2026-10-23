import { createGateway } from "./src/app.js";

const port = Number(process.env.FC_CUSTOM_LISTEN_PORT || process.env.PORT || 9000);
const server = createGateway();
server.timeout = 0;
server.keepAliveTimeout = 0;
server.listen(port, "0.0.0.0", () => console.log(`Aliyun extension gateway listening on ${port}`));
