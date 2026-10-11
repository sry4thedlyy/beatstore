import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PDFDocument } from "pdf-lib";
import type { EditorProduct, UploadKind } from "../src/domain/catalog-editor";
import type { OrderView } from "../src/domain/checkout";
import type { DeliveryView, FreeDownloadView } from "../src/domain/delivery";
import { acceptancePostgres } from "./support/acceptance-postgres";
import {
  capacityMonitor,
  capacityTraffic,
  capacityZip,
  verifyCapacityDownload,
} from "./support/capacity";

const project = fileURLToPath(new URL("../", import.meta.url));
const work = path.join(project, "work");
const serve = process.argv.includes("--serve");
const capacity = process.argv.includes("--capacity");
const postgres = capacity || process.argv.includes("--postgres");
assert(!(serve && capacity), "Capacity check cannot run in interactive mode");
const portOption = process.argv.find((value) => value.startsWith("--port="));
const requestedPort = portOption ? Number(portOption.slice(7)) : 0;
if (
  !Number.isInteger(requestedPort) ||
  requestedPort < 0 ||
  requestedPort > 65535
)
  throw new Error("Use --port=<available local port>.");
await access(path.join(project, ".next/BUILD_ID")).catch(() => {
  throw new Error("Run npm run build before the acceptance check.");
});
await mkdir(work, { recursive: true });
const root = await mkdtemp(path.join(work, "acceptance-"));
let server: ChildProcess | undefined;
let setupProcess: ChildProcess | undefined;
let proxy: ChildProcess | undefined;
let database: Awaited<ReturnType<typeof acceptancePostgres>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of [setupProcess, server, proxy]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  await database?.stop();
  // This directory was created by this run; never remove the working database.
  const target = path.resolve(root);
  if (!target.startsWith(path.resolve(work) + path.sep))
    throw new Error("Invalid acceptance directory.");
  await rm(target, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void stop().then(() => process.exit(0));
  });
async function run() {
  let monitor: Awaited<ReturnType<typeof capacityMonitor>> | undefined;
  try {
    monitor = capacity ? await capacityMonitor() : undefined;
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(requestedPort, "127.0.0.1", resolve);
    });
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    let origin = `http://localhost:${port}`;
    if (postgres) database = await acceptancePostgres(root);
    if (capacity) {
      assert(process.env.CADDY_BIN, "Capacity check requires CADDY_BIN");
      const listener = createServer();
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      const proxyPort = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      origin = `http://localhost:${proxyPort}`;
      const config = path.join(root, "Caddyfile");
      await writeFile(
        config,
        `{\n admin off\n auto_https off\n}\nhttp://localhost:${proxyPort} {\n request_body {\n max_size 525MB\n }\n reverse_proxy 127.0.0.1:${port}\n}\n`,
      );
      proxy = spawn(
        process.env.CADDY_BIN,
        ["run", "--config", config, "--adapter", "caddyfile"],
        {
          cwd: root,
          env: { ...process.env, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root },
          stdio: "inherit",
        },
      );
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      DB_DRIVER: postgres ? "postgres" : "pglite",
      PGLITE_DATA_DIR: path.join(root, ".data/postgres"),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
      PAYMENT_PROVIDER: "demo",
      STORAGE_DRIVER: "local",
      MAIL_DRIVER: "file",
      SMTP_HOST: "",
      SMTP_USER: "",
      SMTP_PASSWORD: "",
      SMTP_FROM: "",
      DATABASE_URL: database?.url ?? "",
      YOOKASSA_SHOP_ID: "",
      YOOKASSA_SECRET_KEY: "",
      YC_STORAGE_BUCKET: "",
      YC_STORAGE_ACCESS_KEY_ID: "",
      YC_STORAGE_SECRET_ACCESS_KEY: "",
      NEXT_TELEMETRY_DISABLED: "1",
    };
    await cp(
      path.join(project, "assets/fonts"),
      path.join(root, "assets/fonts"),
      {
        recursive: true,
      },
    );
    const setup = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        import.meta.resolve("tsx"),
        path.join(project, "tests/support/acceptance-fixture.ts"),
      ],
      { cwd: root, env, stdio: "inherit", windowsHide: true },
    );
    setupProcess = setup;
    const [setupCode] = await once(setup, "exit");
    assert.equal(setupCode, 0, "Acceptance fixtures could not be prepared");
    server = spawn(
      process.execPath,
      [
        path.join(project, "node_modules/next/dist/bin/next"),
        "start",
        project,
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { cwd: root, env, stdio: "inherit", windowsHide: true },
    );
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (server.exitCode !== null || server.signalCode !== null)
        throw new Error("Acceptance server stopped before becoming ready.");
      try {
        const response = await fetch(origin, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          await response.text();
          ready = true;
          break;
        }
        await response.body?.cancel();
      } catch {
        /* The isolated server is still starting. */
      }
      await delay(250);
    }
    assert(ready, "Acceptance server did not become ready");
    if (serve) {
      console.log(
        `Isolated acceptance demo: ${origin}\nUse the demo/admin accounts from README. Ctrl+C stops this test server.\nTemporary test data: ${root}`,
      );
      await once(server, "exit");
    } else {
      const traffic = capacity ? await startCapacityTraffic(origin) : undefined;
      let failure: unknown;
      try {
        await checkShop(origin, root);
      } catch (error) {
        failure = error;
      }
      try {
        await traffic?.finish();
      } catch (error) {
        if (failure)
          throw new AggregateError(
            [failure, error],
            "Acceptance and traffic checks failed",
            { cause: error },
          );
        throw error;
      }
      if (failure) throw failure;
      console.log(
        "Acceptance check passed. Only isolated test data was changed.",
      );
    }
  } finally {
    try {
      await monitor?.finish();
    } finally {
      await stop();
    }
  }
}

class Client {
  private cookies = new Map<string, string>();
  constructor(private origin: string) {}
  async request(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size)
      headers.set(
        "Cookie",
        [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      );
    if (init.method && !["GET", "HEAD"].includes(init.method))
      headers.set("Origin", this.origin);
    const response = await fetch(new URL(url, this.origin), {
      ...init,
      headers,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(30000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0],
        index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async json<T>(url: string, input?: unknown, status = 200, method = "POST") {
    const response = await this.request(
      url,
      input === undefined
        ? {}
        : {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
    );
    assert.equal(response.status, status, `${method} ${url.split("?")[0]}`);
    return (await response.json()) as T;
  }
  async page(url: string, status = 200) {
    const response = await this.request(url);
    assert.equal(response.status, status, url);
    return response.text();
  }
}
async function checkShop(origin: string, root: string) {
  const guest = new Client(origin),
    buyer = new Client(origin),
    other = new Client(origin),
    admin = new Client(origin);
  const beat = "10000000-0000-4000-8000-000000000001";
  const kit = "10000000-0000-4000-8000-000000000003";
  const endpoint = `/api/admin/products/${beat}`;
  assert.match(await guest.page("/"), /Midnight Drive/);
  assert.match(await guest.page("/?q=not-a-product"), /Ничего не найдено/);
  const redirect = await guest.request(`/checkout/${beat}?license=WAV`);
  assert.equal(redirect.status, 307);
  assert.equal(
    new URL(redirect.headers.get("location")!, origin).searchParams.get("next"),
    `/checkout/${beat}?license=WAV`,
  );
  await guest.json("/api/orders", {}, 401);
  await guest.json("/api/admin/products", {}, 401);
  console.log("PASS: catalog, search, guest access");
  await buyer.json("/api/auth/sign-in/email", {
    email: "demo@example.test",
    password: "Beatstore-demo-2026",
  });
  await other.json("/api/auth/sign-up/email", {
    email: "other@example.test",
    password: "Acceptance-test-2026",
    name: "Second Artist",
    role: "ADMIN",
  });
  await admin.json("/api/auth/sign-in/email", {
    email: "admin@example.test",
    password: "Beatstore-admin-2026",
  });
  const kitEditor = await admin.json<EditorProduct>(
    `/api/admin/products/${kit}`,
  );
  await other.json(
    "/api/admin/products",
    { title: "Forbidden", type: "BEAT" },
    403,
  );
  const free = await buyer.json<FreeDownloadView>(
    `/api/products/${beat}/free-download`,
  );
  await buyer.json(
    `/api/products/${beat}/free-download`,
    { accepted: false, revision: free.revision, termsId: free.termsId },
    400,
  );
  const grant = await buyer.json<{ url: string }>(
    `/api/products/${beat}/free-download`,
    { accepted: true, revision: free.revision, termsId: free.termsId },
  );
  assert.equal((await buyer.request(grant.url)).status, 200);
  await other.json(grant.url, undefined, 404);
  assert.equal(
    (await buyer.json<FreeDownloadView>(`/api/products/${beat}/free-download`))
      .accepted,
    true,
  );
  console.log(
    "PASS: account roles, free MP3 acceptance, account-bound download",
  );
  const editor = () => admin.json<EditorProduct>(endpoint);
  const orderInput = async (kind: string) => ({
    productId: beat,
    kind,
    revision: (await editor()).revision,
    requestKey: randomUUID(),
    accepted: true,
  });
  const input = await orderInput("WAV");
  const order = await buyer.json<OrderView>(
    "/api/orders",
    { ...input, price: 1 },
    201,
  );
  assert.equal(order.total, 180000);
  assert.equal(
    (await buyer.json<OrderView>("/api/orders", input, 201)).id,
    order.id,
  );
  await buyer.json(`/api/orders/${order.id}/delivery`, { action: "file" }, 409);
  await other.json(`/api/orders/${order.id}`, undefined, 404);
  await other.json("/api/orders", await orderInput("EXCLUSIVE"), 409);
  assert.equal(
    (
      await buyer.json<OrderView>(`/api/orders/${order.id}`, {
        action: "demo-success",
      })
    ).status,
    "PAID",
  );
  assert.equal(
    (
      await buyer.json<OrderView>(`/api/orders/${order.id}`, {
        action: "demo-success",
      })
    ).status,
    "PAID",
  );
  const file = await buyer.json<{ url: string }>(
    `/api/orders/${order.id}/delivery`,
    { action: "file" },
  );
  const audio = await buyer.request(file.url, {
    headers: { Range: "bytes=0-31" },
  });
  assert.equal(audio.status, 206);
  assert.equal((await audio.arrayBuffer()).byteLength, 32);
  assert.equal(
    (await guest.request(`/media/${order.snapshot.file.id}`)).status,
    404,
  );
  await other.json(file.url, undefined, 404);
  const document = await buyer.json<{ url: string }>(
    `/api/orders/${order.id}/delivery`,
    { action: "document" },
  );
  const pdf = Buffer.from(
    await (await buyer.request(document.url)).arrayBuffer(),
  );
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
  assert.match(await buyer.page(`/orders/${order.id}`), /Скачать лицензию PDF/);
  console.log(
    "PASS: server price, request replay, payment, WAV, PDF, private routes",
  );
  const repeat = await buyer.json<OrderView>(
    "/api/orders",
    await orderInput("WAV"),
    201,
  );
  assert.notEqual(repeat.id, order.id);
  assert.equal(
    (
      await buyer.json<OrderView>(`/api/orders/${repeat.id}`, {
        action: "demo-cancel",
      })
    ).status,
    "CANCELLED",
  );
  let current = await editor();
  const upload = async (kind: UploadKind, name: string, bytes: Buffer) => {
    const response = await admin.request(`${endpoint}/files/${kind}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(name),
        "X-File-Size": String(bytes.length),
        "X-Product-Revision": String(current.revision),
      },
      body: Uint8Array.from(bytes),
    });
    assert.equal(response.status, 200, `upload ${kind}`);
    current = (await response.json()) as EditorProduct;
  };
  await upload(
    "WAV",
    "replacement.wav",
    await readFile(path.join(root, ".data/demo-assets/afterhours/beat.wav")),
  );
  assert.notEqual(current.files.WAV!.id, order.snapshot.file.id);
  assert.equal(
    (await buyer.json<OrderView>(`/api/orders/${order.id}`)).snapshot.file.id,
    order.snapshot.file.id,
  );
  assert.deepEqual(
    Buffer.from(await (await buyer.request(document.url)).arrayBuffer()),
    pdf,
  );
  const exclusive = await other.json<OrderView>(
    "/api/orders",
    await orderInput("EXCLUSIVE"),
    201,
  );
  await buyer.json("/api/orders", await orderInput("MP3"), 409);
  await admin.json(
    endpoint,
    { ...editorInput(current), action: "save" },
    409,
    "PATCH",
  );
  assert.equal(
    (
      await other.json<OrderView>(`/api/orders/${exclusive.id}`, {
        action: "demo-success",
      })
    ).status,
    "PAID",
  );
  assert.doesNotMatch(await guest.page("/"), /Midnight Drive/);
  assert.equal((await buyer.request(file.url)).status, 200);
  await buyer.json(grant.url, undefined, 404);
  await buyer.json("/api/orders", await orderInput("WAV"), 409);
  console.log(
    "PASS: repeat purchase, cancellation, file versions, exclusive reservation and sale",
  );
  const kitOrder = await buyer.json<OrderView>(
    "/api/orders",
    {
      productId: kit,
      kind: "DRUMKIT",
      revision: kitEditor.revision,
      requestKey: randomUUID(),
      accepted: true,
    },
    201,
  );
  await buyer.json(`/api/orders/${kitOrder.id}`, { action: "demo-success" });
  const kitDelivery = await buyer.json<DeliveryView>(
    `/api/orders/${kitOrder.id}/delivery`,
  );
  assert.equal(kitDelivery.document, null);
  const archive = await buyer.json<{ url: string }>(
    `/api/orders/${kitOrder.id}/delivery`,
    { action: "file" },
  );
  const kitResponse = await buyer.request(archive.url);
  assert.equal(kitResponse.status, 200);
  assert.equal(kitResponse.headers.get("Content-Type"), "application/zip");
  await kitResponse.arrayBuffer();
  let draft = await admin.json<EditorProduct>(
    "/api/admin/products",
    { title: "Acceptance draft", type: "DRUMKIT" },
    201,
  );
  assert.doesNotMatch(await guest.page("/"), /Acceptance draft/);
  assert.equal((await guest.request(`/products/${draft.id}`)).status, 404);
  await admin.json(
    `/api/admin/products/${draft.id}`,
    { ...editorInput(draft), action: "publish" },
    400,
    "PATCH",
  );
  draft = await admin.json<EditorProduct>(
    `/api/admin/products/${draft.id}`,
    {
      ...editorInput(draft),
      price: "800",
      usageRules: kitEditor.usageRules,
      action: "save",
    },
    200,
    "PATCH",
  );
  const largeZip = capacity ? await capacityZip(root) : undefined;
  for (const [kind, name] of [
    ["COVER", "cover.jpg"],
    ["PREVIEW", "preview.mp3"],
    ["DRUMKIT", "drumkit.zip"],
  ] as const) {
    const streamed = kind === "DRUMKIT" ? largeZip : undefined;
    if (capacity) console.log(`CAPACITY_PHASE upload ${kind}`);
    const bytes = streamed
      ? undefined
      : await readFile(path.join(root, ".data/demo-assets/dust", name));
    const response = await admin.request(
      `/api/admin/products/${draft.id}/files/${kind}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": name,
          "X-File-Size": String(streamed?.size ?? bytes!.length),
          "X-Product-Revision": String(draft.revision),
        },
        body: streamed ? streamed.stream() : Uint8Array.from(bytes!),
        ...(streamed
          ? { duplex: "half", signal: AbortSignal.timeout(180000) }
          : {}),
      } as RequestInit,
    );
    assert.equal(response.status, 200, `new drumkit upload ${kind}`);
    draft = (await response.json()) as EditorProduct;
    if (capacity) console.log(`CAPACITY_PHASE uploaded ${kind}`);
  }
  assert.deepEqual(draft.missing, []);
  draft = await admin.json<EditorProduct>(
    `/api/admin/products/${draft.id}`,
    { ...editorInput(draft), action: "publish" },
    200,
    "PATCH",
  );
  assert.match(await guest.page("/"), /Acceptance draft/);
  if (largeZip) {
    console.log("CAPACITY_PHASE purchase large ZIP");
    const largeOrder = await buyer.json<OrderView>(
      "/api/orders",
      {
        productId: draft.id,
        kind: "DRUMKIT",
        revision: draft.revision,
        requestKey: randomUUID(),
        accepted: true,
      },
      201,
    );
    await buyer.json(`/api/orders/${largeOrder.id}`, {
      action: "demo-success",
    });
    const download = await buyer.json<{ url: string }>(
      `/api/orders/${largeOrder.id}/delivery`,
      { action: "file" },
    );
    await verifyCapacityDownload(
      await buyer.request(download.url, {
        signal: AbortSignal.timeout(180000),
      }),
      largeZip,
    );
  }
  assert.equal(
    (await guest.request(`/media/${draft.files.PREVIEW!.id}`)).status,
    200,
  );
  draft = await admin.json<EditorProduct>(
    `/api/admin/products/${draft.id}`,
    { ...editorInput(draft), action: "unpublish" },
    200,
    "PATCH",
  );
  assert.doesNotMatch(await guest.page("/"), /Acceptance draft/);
  assert.equal(
    (await guest.request(`/media/${draft.files.PREVIEW!.id}`)).status,
    404,
  );
  draft = await admin.json<EditorProduct>(
    `/api/admin/products/${draft.id}`,
    { ...editorInput(draft), action: "publish" },
    200,
    "PATCH",
  );
  await admin.json(
    `/api/admin/products/${draft.id}`,
    { revision: draft.revision, confirmation: draft.title },
    capacity ? 409 : 200,
    "DELETE",
  );
  console.log(
    "PASS: drumkit delivery, draft, cover/audio/ZIP uploads, publication and deletion rules",
  );
  await buyer.json("/api/auth/request-password-reset", {
    email: "demo@example.test",
    redirectTo: "/reset-password",
  });
  const { readdir } = await import("node:fs/promises");
  const mailbox = path.join(root, ".data/mail");
  let mailName: string | undefined;
  for (let attempt = 0; attempt < 100 && !mailName; attempt++) {
    try {
      mailName = (await readdir(mailbox))[0];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!mailName) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(mailName, "Password reset mail must arrive after the response");
  const mail = JSON.parse(
    await readFile(path.join(root, ".data/mail", mailName), "utf8"),
  ) as { url: string };
  const link = await guest.request(mail.url);
  const token = new URL(link.headers.get("location")!, origin).searchParams.get(
    "token",
  );
  assert(token);
  await guest.json("/api/auth/reset-password", {
    token,
    newPassword: "Acceptance-new-password-2026",
  });
  await buyer.json(`/api/orders/${order.id}`, undefined, 401);
  await guest.json(
    "/api/auth/reset-password",
    { token, newPassword: "Another-password-2026" },
    400,
  );
  await buyer.json("/api/auth/sign-in/email", {
    email: "demo@example.test",
    password: "Acceptance-new-password-2026",
  });
  assert.match(await buyer.page("/account"), /Midnight Drive/);
  await buyer.json("/api/auth/sign-out", {});
  await buyer.json(`/api/orders/${order.id}`, undefined, 401);
  console.log(
    "PASS: password reset through local mail, one-time token, revoked sessions, sign-out",
  );
}
async function startCapacityTraffic(origin: string) {
  const client = new Client(origin);
  await client.json("/api/auth/sign-in/email", {
    email: "admin@example.test",
    password: "Beatstore-admin-2026",
  });
  const product = await client.json<EditorProduct>(
    "/api/admin/products/10000000-0000-4000-8000-000000000003",
  );
  return capacityTraffic(
    origin,
    `/media/${product.files.PREVIEW!.id}`,
    `/media/${product.files.COVER!.id}`,
  );
}
function editorInput(product: EditorProduct) {
  return {
    ...product,
    price: product.price === null ? "" : String(product.price / 100),
    bpm: product.bpm ?? "",
    musicalKey: product.musicalKey ?? "",
    royalty: product.royalty ?? "0",
    projectRequirements: product.projectRequirements ?? "",
  };
}

await run();
