import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface ResetMail {
  email: string;
  url: string;
}

export async function saveResetMail({ email, url }: ResetMail): Promise<void> {
  const directory = path.resolve(/*turbopackIgnore: true*/ ".data/mail");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, `${Date.now()}-${randomUUID()}.json`),
    JSON.stringify(
      {
        to: email,
        subject: "Beatstore — восстановление пароля",
        createdAt: new Date().toISOString(),
        text: `Для смены пароля открой ссылку. Она действует 30 минут и используется один раз.\n\n${url}\n\nЕсли ты не запрашивал смену пароля, просто проигнорируй письмо.`,
        url,
      },
      null,
      2,
    ),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}
