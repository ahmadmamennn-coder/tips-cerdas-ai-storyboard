
const TEXT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json"
    }
  });
}

function extractText(result) {
  if (typeof result === "string") return result;

  if (!result || typeof result !== "object") return "";

  const possible = [
    result.response,
    result.output_text,
    result.text,
    result.result?.response,
    result.result?.text,
    result.content?.[0]?.text
  ];

  for (const value of possible) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return JSON.stringify(result);
}

function parseJSON(raw) {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  for (let start = 0; start < cleaned.length; start++) {
    const first = cleaned[start];

    if (first !== "{" && first !== "[") continue;

    const stack = [];
    let inString = false;
    let escaped = false;

    for (let i = start; i < cleaned.length; i++) {
      const char = cleaned[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
      } else if (char === "}" || char === "]") {
        const last = stack.pop();

        if (
          (char === "}" && last !== "{") ||
          (char === "]" && last !== "[")
        ) {
          break;
        }

        if (stack.length === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error("AI memberikan respons yang bukan JSON valid.");
}

function findScenes(data, depth = 0) {
  if (!data || depth > 6) return null;

  if (Array.isArray(data)) {
    if (
      data.length &&
      data.some(item =>
        item &&
        typeof item === "object" &&
        (
          item.visualPrompt ||
          item.visual_prompt ||
          item.cameraDirection ||
          item.narration ||
          item.description
        )
      )
    ) {
      return data;
    }

    for (const item of data) {
      const found = findScenes(item, depth + 1);
      if (found) return found;
    }

    return null;
  }

  if (typeof data !== "object") return null;

  const preferredKeys = [
    "scenes",
    "storyboard",
    "shots",
    "episodes",
    "data",
    "output",
    "result",
    "response"
  ];

  for (const key of preferredKeys) {
    if (data[key] !== undefined) {
      const found = findScenes(data[key], depth + 1);
      if (found) return found;
    }
  }

  for (const value of Object.values(data)) {
    const found = findScenes(value, depth + 1);
    if (found) return found;
  }

  return null;
}

function normalizeScene(scene, index) {
  return {
    title: scene.title || scene.name || `Adegan ${index + 1}`,
    visualPrompt:
      scene.visualPrompt ||
      scene.visual_prompt ||
      scene.imagePrompt ||
      scene.description ||
      "",
    cameraDirection:
      scene.cameraDirection ||
      scene.camera_direction ||
      scene.camera ||
      "",
    narration:
      scene.narration ||
      scene.voiceover ||
      scene.dialogue ||
      "",
    sound:
      scene.sound ||
      scene.soundDesign ||
      scene.audio ||
      ""
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        status: "online",
        aiConfigured: Boolean(env.AI),
        message: "Tips Cerdas AI is running."
      });
    }

    if (
      url.pathname !== "/api/generate" ||
      request.method !== "POST"
    ) {
      return json({ error: "Endpoint tidak ditemukan." }, 404);
    }

    if (!env.AI) {
      return json({
        error: "AI binding belum diaktifkan."
      }, 503);
    }

    try {
      const body = await request.json();

      const idea = String(body.idea || "").trim();
      const language =
        body.language === "en" ? "English" : "Indonesian";
      const style = String(body.style || "cinematic");
      const count = [5, 10, 15].includes(Number(body.scenes))
        ? Number(body.scenes)
        : 5;

      if (!idea || idea.length > 2000) {
        return json({
          error: "Ide cerita wajib diisi (maksimal 2000 karakter)."
        }, 400);
      }

      const prompt = `
Create an original cinematic storyboard.

Language: ${language}
Visual style: ${style}
Story idea: ${idea}

Create exactly ${count} scenes.

Keep the same characters visually consistent
throughout the entire story.

Return ONLY valid JSON.
Do not use markdown or code fences.

Use exactly this structure:
{
  "title": "Story title",
  "logline": "Short story summary",
  "scenes": [
    {
      "title": "Scene title",
      "visualPrompt": "Detailed image prompt in English",
      "cameraDirection": "Camera angle and movement",
      "narration": "Narration in requested language",
      "sound": "Sound design description"
    }
  ]
}

Every scene must have all five fields.
Make the scenes distinct and connected.
`;

      const textResult = await env.AI.run(TEXT_MODEL, {
        messages: [
          {
            role: "system",
            content:
              "You are a professional screenwriter and storyboard artist. Return valid JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 6000,
        temperature: 0.7
      });

      const raw = extractText(textResult);
      const parsed = parseJSON(raw);

      const scenes = findScenes(parsed);

      if (!scenes || scenes.length === 0) {
        return json({
          error: "AI belum menghasilkan daftar adegan. Coba lagi dengan ide cerita yang lebih sederhana."
        }, 502);
      }

      const story = {
        title:
          parsed.title ||
          parsed.storyTitle ||
          "Untitled Storyboard",
        logline:
          parsed.logline ||
          parsed.summary ||
          "",
        scenes: scenes
          .slice(0, count)
          .map(normalizeScene)
      };

      for (let i = 0; i < story.scenes.length; i++) {
        const scene = story.scenes[i];

        if (!scene.visualPrompt) {
          scene.imageError = "Prompt gambar tidak tersedia.";
          continue;
        }

        try {
          const imageResult = await env.AI.run(IMAGE_MODEL, {
            prompt:
              `Cinematic storyboard frame, ${style} visual style. ` +
              `${scene.visualPrompt}. ` +
              "Professional film lighting, beautiful composition, " +
              "consistent characters, no text, no watermark.",
            steps: 4
          });

          if (
            imageResult &&
            typeof imageResult.image === "string"
          ) {
            scene.image =
              "data:image/jpeg;base64," + imageResult.image;
          } else {
            scene.imageError =
              "Model gambar tidak mengembalikan gambar.";
          }
        } catch (error) {
          scene.imageError =
            "Gagal membuat gambar adegan ini.";
        }
      }

      return json({
        success: true,
        title: story.title,
        logline: story.logline,
        scenes: story.scenes
      });

    } catch (error) {
      return json({
        error:
          error.message ||
          "Terjadi kesalahan pada server."
      }, 500);
    }
  }
};
