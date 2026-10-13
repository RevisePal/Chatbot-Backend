import dotenv from "dotenv";
dotenv.config();
import express from "express";
import OpenAI from "openai";
import cors from "cors";
import BadWords from "bad-words";
import fetch from "node-fetch";
import admin from "firebase-admin";
import crypto from "crypto";

if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : undefined;
  admin.initializeApp(
    serviceAccount
      ? { credential: admin.credential.cert(serviceAccount) }
      : { credential: admin.credential.applicationDefault() }
  );
}

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    if (process.env.ENFORCE_AUTH === "true") {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    return next();
  }
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  try {
    await admin.auth().verifyIdToken(token);
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid authentication token" });
  }
};

const app = express();

// Explicit CORS configuration to support local dev and deployed frontend
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000",
  "https://app.revisepal.com",
  "https://ai.revisepal.com",
  process.env.FRONTEND_ORIGIN || ""
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow non-browser tools (no origin) and allowed origins
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false
};

app.use(cors(corsOptions));
// Ensure preflight requests are handled
app.options("*", cors(corsOptions));

app.use(express.json());
console.log("JSON parsing middleware set up.");

const openai = new OpenAI({
  apiKey: process.env["OPENAI_API_KEY"],
});
const filter = new BadWords();

const port = process.env.PORT || 5000;

app.get("/test", (_req, res) => res.send("OK"));

app.post("/ask", authMiddleware, async (req, res) => {
  console.log("Received request body:", req.body);
  const conversations = req.body.conversations;
  try {
    if (!conversations || conversations.length === 0) {
      throw new Error("No conversation history was provided");
    }
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: conversations,
    });

    const completion = response.choices[0].message.content;
    const filteredCompletion = filter.clean(completion);

    return res.status(200).json({
      success: true,
      message: filteredCompletion,
    });
  } catch (error) {
    console.error("Error in /ask route:", error.message);
    if (error.response) {
      console.error("OpenAI API error response:", error.response);
    }
    if (error.stack) {
      console.error("Error stack:", error.stack);
    }
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing your request.",
    });
  }
});

// --- answer-judgement logging -------------------------------------------------
// Judgements are written here rather than from the app so the verdict cannot be
// forged by a client, and so one judgement is one write no matter how many
// clients produced it. Deliberately stores no uid: the eval set needs the
// question and the answer text, not who typed it.
const VALID_REASONS = new Set([
  "spelling",
  "synonym",
  "verbose",
  "equivalent_concept",
  "wrong_concept",
  "too_vague",
]);

// "exact" cannot be true: the marker is only called once a local exact match has
// already failed. Builds distributed before the rubric dropped it still offer it
// to the model, so keep the raw value for the record and leave `reason` null
// rather than trusting a label we know is wrong.
const IMPOSSIBLE_REASONS = new Set(["exact"]);

// Deliberately conservative: case and whitespace only. This string is part of
// the document key, so under-normalising just splits two records that could
// have been one, while over-normalising would merge answers that are not the
// same answer - "H" and "H\u207A", or "11x - 5y" and "11x 5y" - and hand one of
// them the other's verdict once these records are read as a cache.
function normaliseAnswer(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Keyed on the rubric version too, so a judgement made by an older rubric is
// never merged into - or later served from - a newer one's record.
function judgementId(questionId, normalisedAnswer, promptVersion) {
  return crypto
    .createHash("sha1")
    .update(`${questionId}|${normalisedAnswer}|${promptVersion}`)
    .digest("hex");
}

function parseJudgement(completion) {
  try {
    const parsed = JSON.parse(completion);
    const verdict = String(parsed.verdict || "").trim().toLowerCase();
    if (verdict !== "accept" && verdict !== "reject") return null;
    const reason = String(parsed.reason || "").trim().toLowerCase();
    const confidence = Number(parsed.confidence);
    return {
      verdict,
      reason: VALID_REASONS.has(reason) ? reason : null,
      // What the model actually said, kept whenever it is not a value we
      // accepted, so a mislabel is visible in the data instead of silently
      // becoming null.
      reasonRaw:
        reason && !VALID_REASONS.has(reason)
          ? reason.slice(0, 40)
          : null,
      reasonImpossible: IMPOSSIBLE_REASONS.has(reason),
      confidence: Number.isFinite(confidence)
        ? Math.min(1, Math.max(0, confidence))
        : null,
      canonical: String(parsed.canonical || "").trim().slice(0, 200),
      requires: String(parsed.requires || "").trim().slice(0, 300),
      feedback: String(parsed.feedback || "").trim().slice(0, 300),
    };
  } catch {
    return null;
  }
}

// Set JUDGEMENTS_COLLECTION to write somewhere other than the live collection -
// e.g. "answer_judgements_test" while a TestFlight build is the only thing
// sending `format: "json"`, so trial data never lands among real judgements.
// Unset, judgements go to the live collection.
const JUDGEMENTS_COLLECTION =
  process.env.JUDGEMENTS_COLLECTION || "answer_judgements";

// One document per (question, normalised answer, rubric), with a counter. A
// popular typo costs one document rather than one per attempt, which keeps this
// inside Firestore quota, and leaves a record shaped to be read as a cache
// later. Never throws: a logging failure must not fail the marking request.
async function recordJudgement(meta, judgement, model) {
  if (!meta || !meta.questionId || !judgement) return;
  try {
    const promptVersion = String(meta.promptVersion || "unknown");
    const normalised = normaliseAnswer(meta.studentAnswer);
    const id = judgementId(meta.questionId, normalised, promptVersion);
    const now = admin.firestore.FieldValue.serverTimestamp();
    await admin
      .firestore()
      .collection(JUDGEMENTS_COLLECTION)
      .doc(id)
      .set(
        {
          questionId: meta.questionId,
          questionType: meta.questionType ?? null,
          topicId: meta.topicId ?? null,
          normalisedAnswer: normalised,
          studentAnswer: String(meta.studentAnswer || "").slice(0, 500),
          verdict: judgement.verdict,
          reason: judgement.reason,
          reasonRaw: judgement.reasonRaw,
          reasonImpossible: judgement.reasonImpossible,
          confidence: judgement.confidence,
          canonical: judgement.canonical,
          requires: judgement.requires,
          feedback: judgement.feedback,
          promptVersion,
          model,
          count: admin.firestore.FieldValue.increment(1),
          firstSeenAt: now,
          lastSeenAt: now,
        },
        { merge: true }
      );
  } catch (error) {
    console.error("[checkGTP] failed to record judgement:", error.message);
  }
}

// Railway splits log output on newlines and does not guarantee their order, so
// a multi-line prompt came out shuffled and unreadable. Everything below is
// logged as exactly one line per request. The rubric itself is not logged: it is
// identical on every call and identified by promptVersion, so printing it just
// pushed the diagnostic lines out of retention. Set DEBUG_PROMPTS=true to get
// the full conversation back when a prompt change needs inspecting.
function summariseUserTurn(conversations) {
  const turn = conversations[conversations.length - 1];
  const content = turn?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter(part => part?.type === "text")
    .map(part => part.text)
    .join(" ");
  const images = content.filter(part => part?.type === "image_url").length;
  return images > 0 ? `${text} [+${images} image(s)]` : text;
}

const MARKER_MODEL = "gpt-4o-mini";

app.post("/checkGTP", authMiddleware, async (req, res) => {
  const conversations = req.body.conversations;
  // Only clients that ask for json get json. Builds already on phones send
  // neither `format` nor `meta` and parse the reply with startsWith("yes"), so
  // switching them to a json reply would mark every answer wrong. Their path
  // through this route has to stay byte-for-byte what it was.
  const wantsJson = req.body.format === "json";
  const meta = req.body.meta;
  try {
    if (!conversations || conversations.length === 0) {
      throw new Error("No conversation history was provided");
    }
    console.log(
      `[checkGTP] ask q=${meta?.questionId || "-"} v=${
        meta?.promptVersion || "legacy"
      } ${JSON.stringify(summariseUserTurn(conversations))}`
    );
    if (process.env.DEBUG_PROMPTS === "true") {
      console.log(`[checkGTP] full=${JSON.stringify(conversations)}`);
    }
    // Marking must be deterministic: the same student answer has to get the
    // same verdict on every attempt, and for every student.
    const response = await openai.chat.completions.create({
      model: MARKER_MODEL,
      messages: conversations,
      temperature: 0,
      max_tokens: 200,
      ...(wantsJson ? { response_format: { type: "json_object" } } : {}),
    });
    const completion = response.choices[0].message.content;
    console.log(
      `[checkGTP] got q=${meta?.questionId || "-"} ${JSON.stringify(completion)}`
    );

    if (wantsJson) {
      const judgement = parseJudgement(completion);
      // Logging is awaited so a cold Railway instance cannot be torn down
      // mid-write, but it can never fail the response.
      await recordJudgement(meta, judgement, MARKER_MODEL);
    }

    return res.status(200).json({
      success: true,
      message: completion,
    });
  } catch (error) {
    console.error("Error in /checkGTP route:", error.message);
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing your request.",
    });
  }
});

app.post("/canvasProxy", async (req, res) => {
  const { apiKey, classCode } = req.body;

  try {
    const canvasResponse = await fetch(
      `https://canvas.instructure.com/api/v1/courses/${classCode}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );

    const data = await canvasResponse.json();

    if (!canvasResponse.ok) {
      console.error("Canvas API response not OK:", data);
      return res.status(canvasResponse.status).send(data);
    }

    res.status(200).json(data);
  } catch (error) {
    console.error("Error in canvasProxy:", error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.all("/sections", async (req, res) => {
  const { apiKey, classCode } = req.method === "POST" ? req.body : req.query;

  if (!apiKey || !classCode) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  const canvasDomain = "https://canvas.instructure.com";
  const url = `${canvasDomain}/api/v1/courses/${classCode}/sections`;

  try {
    const canvasResponse = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!canvasResponse.ok) {
      const errorResponse = await canvasResponse.text();
      throw new Error(`Canvas API request failed: ${errorResponse}`);
    }

    const sections = await canvasResponse.json();
    res.status(200).json(sections);
  } catch (error) {
    console.error("Error fetching sections:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch sections", details: error.message });
  }
});

app.post("/announcements", async (req, res) => {
  const { courseId, title, message, apiKey } = req.body;

  if (!courseId || !title || !message || !apiKey) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  const canvasUrl = `https://canvas.instructure.com/api/v1/courses/${courseId}/discussion_topics`;

  try {
    const canvasResponse = await fetch(canvasUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: title,
        message: message,
        is_announcement: true,
      }),
    });

    if (!canvasResponse.ok) {
      const errorResponse = await canvasResponse.text();
      throw new Error(`Canvas API request failed: ${errorResponse}`);
    }

    res.status(200).json({ message: "Announcement created" });
  } catch (error) {
    console.error("Error creating announcement:", error);
    res.status(500).json({
      error: "Failed to create announcement",
      details: error.message,
    });
  }
});

app.all("/students", async (req, res) => {
  const { apiKey, courseId, sectionName } =
    req.method === "POST" ? req.body : req.query;

  if (!apiKey || !courseId || !sectionName) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  const canvasDomain = "https://canvas.instructure.com";

  try {
    const sectionsUrl = `${canvasDomain}/api/v1/courses/${courseId}/sections`;
    const sectionsResponse = await fetch(sectionsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!sectionsResponse.ok) {
      throw new Error("Failed to fetch sections");
    }

    const sections = await sectionsResponse.json();
    const section = sections.find((s) => s.name === sectionName);

    if (!section) {
      return res.status(404).json({ error: "Section not found" });
    }

    const studentsUrl = `${canvasDomain}/api/v1/sections/${section.id}/enrollments?enrollment_type=student&per_page=100`;
    const studentsResponse = await fetch(studentsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!studentsResponse.ok) {
      throw new Error("Failed to fetch students for the section");
    }

    const students = await studentsResponse.json();
    const studentEnrollments = students.filter(
      (enrollment) => enrollment.type === "StudentEnrollment"
    );

    res.status(200).json(studentEnrollments);
  } catch (error) {
    console.error("Error fetching students:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch students", details: error.message });
  }
});

app.post("/question-generator", async (req, res) => {
  console.log("Entered /question-generator endpoint");
  const { prompt } = req.body;
  
  if (!prompt) {
    console.log("No prompt provided in request body.");
    return res
      .status(400)
      .json({ success: false, message: "No prompt provided" });
  }
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: prompt }],
    });

    console.log("OpenAI API response:", response);
    const message = response.choices[0].message.content;
    console.log("Generated message:", message);
    
    return res.status(200).json({ success: true, message: message });
  } catch (error) {
    console.error("Error in /question-generator route:", error);
    if (error.response) {
      console.error("OpenAI API error response:", error.response);
    }
    if (error.stack) {
      console.error("Error stack:", error.stack);
    }
    return res.status(500).json({
      success: false,
      message: "An error occurred while processing your request.",
    });
  }
});

app.listen(port, () =>
  console.log(
    `Server is running on port ${port}!! (judgements -> ${JUDGEMENTS_COLLECTION})`
  )
);
