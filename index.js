import { Octokit } from "@octokit/rest";
import axios from "axios";
import bodyParser from "body-parser";
import crypto from "crypto";
import express from "express";

import { Datastore } from "@google-cloud/datastore";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { VertexAI } from "@google-cloud/vertexai";

const datastore = new Datastore();
const secretManagerClient = new SecretManagerServiceClient();

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
if (!GCP_PROJECT_ID) {
  console.error("🚨 環境変数 GCP_PROJECT_ID が設定されていません。");
  process.exit(1);
}

async function getGitHubToken() {
  const secretName = `projects/${GCP_PROJECT_ID}/secrets/GITHUB_TOKEN/versions/latest`;
  try {
    const [version] = await secretManagerClient.accessSecretVersion({
      name: secretName,
    });
    const payload = version.payload.data.toString("utf8");
    console.log("✅ GitHub Token を Secret Manager から取得しました。");
    return payload;
  } catch (err) {
    console.error(
      `🚨 Secret Manager から GitHub Token (${secretName}) の取得に失敗しました:`,
      err
    );
    process.exit(1);
  }
}

let octokit;

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const vertexAi = new VertexAI({
  project: GCP_PROJECT_ID,
  location: "us-central1",
});
const model = "gemini-2.5-pro-exp-03-25";
const generativeModel = vertexAi.getGenerativeModel({ model });

app.get("/liveness_check", (req, res) => {
  res.status(200).send("OK");
});
app.get("/readiness_check", (req, res) => {
  res.status(200).send("OK");
});

function parseAiResponse(responseText) {
  const files = [];
  const regex =
    /<<<<<<< FILE: (.*?) >>>>>>>\n([\s\S]*?)(?=\n<<<<<<< FILE:|\n*$)/gs;
  let match;

  while ((match = regex.exec(responseText)) !== null) {
    const filePath = match[1].trim();
    const fileContent = match[2].trim();
    if (filePath && fileContent) {
      files.push({ path: filePath, content: fileContent });
    }
  }
  if (files.length === 0 && responseText.trim().length > 0) {
    console.warn(
      "⚠️ AI応答にファイル区切りが見つかりません。応答全体を README.md として扱います。"
    );
    let defaultPath = "README.md";
    if (
      responseText.trim().startsWith("import") ||
      responseText.trim().startsWith("function")
    )
      defaultPath = "index.js";
    if (
      responseText.trim().startsWith("{") ||
      responseText.trim().startsWith("[")
    )
      defaultPath = "data.json";
    files.push({ path: defaultPath, content: responseText.trim() });
  }
  return files;
}

app.post("/slack/command", async (req, res) => {
  const { text, user_name, response_url } = req.body;
  const repoMatch = text.match(/--repo=(\S+)/);
  const repo = repoMatch ? repoMatch[1] : null;
  const userPrompt = text.replace(/--repo=\S+/, "").trim();

  if (!repo) {
    return res.send(
      "⚠️ リポジトリが指定されていません: --repo=user/repo 形式で指定してください"
    );
  }

  res.send(
    `✅ 了解「${userPrompt}」（${repo} にPR出すね）...処理を開始します。`
  );

  try {
    const [owner, repoName] = repo.split("/");
    const contextDocId = `${owner}__${repoName}`;
    let fileList = "";
    let codingRules = "";

    const contextKind = "RepoContext";
    const contextKey = datastore.key([contextKind, contextDocId]);

    const [contextEntity] = await datastore.get(contextKey);

    if (
      contextEntity &&
      contextEntity.updated &&
      contextEntity.updated > new Date(Date.now() - 5 * 60 * 1000)
    ) {
      fileList = contextEntity.fileList;
      codingRules = contextEntity.codingRules || "";
      console.log("✅ Datastoreキャッシュ使用");
    } else {
      const treeResp = await octokit.git.getTree({
        owner,
        repo: repoName,
        tree_sha: "main",
        recursive: true,
      });

      const allFiles = treeResp.data.tree.filter(
        (item) => item.type === "blob"
      );
      const rootFiles = allFiles.filter((f) => !f.path.includes("/"));
      const prioritized = allFiles.filter((f) =>
        f.path.match(
          /^(.clinerules$|src\/|app\/|doc\/|docs\/|README|\.env|index\.[jt]s)$/
        )
      );
      const rest = allFiles.filter(
        (f) => !prioritized.includes(f) && !rootFiles.includes(f)
      );
      const sorted = [...rootFiles, ...prioritized, ...rest];

      let estTokenCount = 0;
      const maxToken = 8000;
      const selectedFiles = [];
      for (const file of sorted) {
        const est = Math.ceil(file.path.length / 4);
        if (estTokenCount + est > maxToken) break;
        estTokenCount += est;
        selectedFiles.push(file.path);
      }
      fileList = selectedFiles.join("\n");

      const clinerulesFile = allFiles.find((f) => f.path === ".clinerules");
      if (clinerulesFile) {
        try {
          const { data } = await octokit.repos.getContent({
            owner,
            repo: repoName,
            path: ".clinerules",
          });
          const content = Buffer.from(data.content, "base64").toString("utf8");
          codingRules = content;
        } catch (e) {
          console.warn("⚠️ .clinerulesの取得に失敗:", e);
        }
      }

      const entityToSave = {
        key: contextKey,
        data: [
          { name: "fileList", value: fileList, excludeFromIndexes: true },
          { name: "codingRules", value: codingRules, excludeFromIndexes: true },
          { name: "updated", value: new Date() },
        ],
      };
      await datastore.save(entityToSave);
      console.log("📦 GitHubからコンテキスト取得 & Datastoreにキャッシュ保存");
    }

    const aiPrompt =
      `あなたはこのリポジトリのAIエージェントです。以下の指示を元に、変更が必要なファイルの完全な最終コンテンツを生成してください。\n\n` +
      `指示：「${userPrompt}」\n\n` +
      (codingRules
        ? `以下のコーディングルールを守ってください：\n${codingRules}\n\n`
        : "") +
      `このリポジトリの構成は以下の通りです：\n${fileList}\n\n` +
      `重要：変更または新規作成する各ファイルについて、以下の形式でその完全な内容を出力してください。ファイルが複数ある場合は、この形式を繰り返してください。\n` +
      `<<<<<<< FILE: path/to/your/file.ext >>>>>>>\n` +
      `[ここに file.ext の完全な内容を記述]\n`;

    const result = await generativeModel.generateContent({
      contents: [{ role: "user", parts: [{ text: aiPrompt }] }],
    });

    const aiResponseText = result.response.candidates[0].content.parts[0].text;
    console.log("🧠 AI Response:\n", aiResponseText);

    const filesToWrite = parseAiResponse(aiResponseText);

    if (filesToWrite.length === 0) {
      throw new Error("AIが有効なファイルコンテンツを生成しませんでした。");
    }

    const now = new Date();
    const timestamp = `${now.getFullYear()}${(now.getMonth() + 1)
      .toString()
      .padStart(2, "0")}${now.getDate().toString().padStart(2, "0")}-${now
      .getHours()
      .toString()
      .padStart(2, "0")}${now.getMinutes().toString().padStart(2, "0")}${now
      .getSeconds()
      .toString()
      .padStart(2, "0")}`;
    const randomSuffix = crypto.randomBytes(2).toString("hex");
    const uniqueId = `${timestamp}-${randomSuffix}`;
    const branchName = `ai-generated-${uniqueId}`;

    const mainRef = await octokit.git.getRef({
      owner,
      repo: repoName,
      ref: "heads/main",
    });
    const mainSha = mainRef.data.object.sha;

    await octokit.git.createRef({
      owner,
      repo: repoName,
      ref: `refs/heads/${branchName}`,
      sha: mainSha,
    });
    console.log(`✅ ブランチ '${branchName}' を作成しました。`);

    for (const file of filesToWrite) {
      const filePath = file.path;
      const fileContent = file.content;
      let existingFileSha = null;

      try {
        const { data: existingFile } = await octokit.repos.getContent({
          owner,
          repo: repoName,
          path: filePath,
          ref: branchName,
        });
        existingFileSha = existingFile.sha;
        console.log(
          `ℹ️ ファイル '${filePath}' をブランチ '${branchName}' 上で更新します。SHA: ${existingFileSha}`
        );
      } catch (error) {
        if (error.status !== 404) {
          throw error;
        }
        console.log(
          `ℹ️ ファイル '${filePath}' はブランチ '${branchName}' に存在しません。新規作成します。`
        );
      }

      const fileOptions = {
        owner,
        repo: repoName,
        path: filePath,
        message: `feat: apply AI changes for ${filePath} prompted by "${userPrompt}"`,
        content: Buffer.from(fileContent).toString("base64"),
        branch: branchName,
      };
      if (existingFileSha) {
        fileOptions.sha = existingFileSha;
      }

      await octokit.repos.createOrUpdateFileContents(fileOptions);
      console.log(
        `✅ ファイル '${filePath}' をブランチ '${branchName}' に書き込みました。`
      );
    }

    const pr = await octokit.pulls.create({
      owner,
      repo: repoName,
      title: `AI: ${userPrompt}`,
      head: branchName,
      base: "main",
      body: `このPRはSlackBot経由で生成されました。\n\n指示内容:\n${userPrompt}\n\n変更ファイル:\n${filesToWrite
        .map((f) => `- ${f.path}`)
        .join("\n")}`,
    });

    if (response_url) {
      await axios.post(response_url, {
        text: `✅ PR作成完了！ <${pr.data.html_url}|Pull Requestを確認する>`,
      });
    }
  } catch (error) {
    console.error("🚨 処理中にエラーが発生しました:", error);
    if (response_url) {
      try {
        await axios.post(response_url, {
          response_type: "ephemeral",
          text: `❌ 処理中にエラーが発生しました。\n\`\`\`${
            error.message || error
          }\`\`\``,
        });
      } catch (slackError) {
        console.error("🚨 Slackへのエラー通知送信に失敗しました:", slackError);
      }
    }
  }
});

async function startServer() {
  const githubToken = await getGitHubToken();
  if (!githubToken) {
    console.error("GitHubトークンが取得できなかったため、起動を中止します。");
    return;
  }
  octokit = new Octokit({ auth: githubToken });

  app.listen(process.env.PORT || 8080, () => {
    console.log(` SlackBot起動中 on port ${process.env.PORT || 8080}...`);
  });
}

startServer();
