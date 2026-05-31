import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import express from "express";
import multer from "multer";

import { transcribeAudio } from "../asr/transcriber.js";
import { outputText } from "../input/outputText.js";
import { resolveAutoPaste } from "./uploadOptions.js";

export function createUploadRouter({ config, wsHub, tmpDir }) {
  const router = express.Router();
  const upload = multer({
    storage: multer.diskStorage({
      destination: tmpDir,
      filename: (_req, file, callback) => {
        const ext = path.extname(file.originalname || "") || ".webm";
        callback(null, `${crypto.randomUUID()}${ext}`);
      }
    }),
    fileFilter: (_req, file, callback) => {
      const allowed = [
        "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4",
        "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave",
        "multipart/form-data"
      ];
      if (allowed.includes(file.mimetype)) {
        callback(null, true);
      } else {
        callback(new Error("不支持的音频格式，请使用 webm、ogg、mp3、wav 或 m4a 格式。"));
      }
    },
    limits: {
      fileSize: 25 * 1024 * 1024,
      fields: 10,
      files: 1
    }
  });

  router.post("/upload", upload.single("audio"), async (req, res) => {
    const filePath = req.file?.path;

    try {
      if (!filePath) {
        return res.status(400).json({
          ok: false,
          error: "没有收到音频文件。"
        });
      }

      const autoPaste = resolveAutoPaste(req.body.autoPaste, config.autoPaste);
      const targetWindow = (req.body.targetAppName && req.body.targetWindowTitle)
        ? { appName: req.body.targetAppName, windowTitle: req.body.targetWindowTitle }
        : null;
      wsHub.broadcast({
        type: "status",
        status: "transcribing",
        message: "正在识别..."
      });

      const text = await transcribeAudio({ filePath, tmpDir }, config);

      wsHub.broadcast({
        type: "result",
        text,
        message: "识别完成"
      });

      const output = await outputText(text, { autoPaste, targetWindow });

      wsHub.broadcast({
        type: "output",
        text,
        copied: output.copied,
        pasted: output.pasted,
        pasteError: output.pasteError
      });

      return res.json({
        ok: true,
        text,
        output
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      const message = error.publicMessage || "语音识别或写入剪切板失败。";
      console.error(error);

      wsHub.broadcast({
        type: "error",
        message
      });

      return res.status(statusCode).json({
        ok: false,
        error: message
      });
    } finally {
      if (filePath) {
        await fs.rm(filePath, { force: true });
      }
    }
  });

  router.use((error, _req, res, next) => {
    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        ok: false,
        error: error.code === "LIMIT_FILE_SIZE" ? "音频文件太大，最大支持 25 MB。" : "音频上传失败。"
      });
    }
    if (error.message === "不支持的音频格式，请使用 webm、ogg、mp3、wav 或 m4a 格式。") {
      return res.status(400).json({
        ok: false,
        error: error.message
      });
    }
    return next(error);
  });

  return router;
}
