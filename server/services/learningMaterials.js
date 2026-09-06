// Retrieval corpus is sourced from existing GridFS, never a duplicate database.
const { Worker } = require("node:worker_threads");
const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");
const { materialAccess, requireDatabase, escapeRegex } = require("./access");
const MAX_TEXT = 60000;

async function extractText(buffer, contentType) {
  if (buffer.length > 16 * 1024 * 1024) return { text: "", status: "too_large_for_text_extraction" };
  if (/^text\//.test(contentType)) return { text: buffer.toString("utf8").slice(0, MAX_TEXT), status: "indexed" };
  if (contentType !== "application/pdf") return { text: "", status: "non_text_material" };
  return new Promise((resolve) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      require(workerData.parser)(Buffer.from(workerData.bytes)).then(r => parentPort.postMessage({ text: String(r.text || '').slice(0, 60000), status: r.text?.trim() ? 'indexed' : 'ocr_required' })).catch(() => parentPort.postMessage({text:'',status:'extraction_failed'}));`,
    { eval: true, workerData: { bytes: buffer, parser: require.resolve("pdf-parse") }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let finished = false;
    const finish = (result) => { if (finished) return; finished = true; clearTimeout(timer); worker.terminate(); resolve(result); };
    const timer = setTimeout(() => finish({ text: "", status: "extraction_timeout" }), 10000);
    worker.once("message", finish);
    worker.once("error", () => finish({ text: "", status: "extraction_failed" }));
    worker.once("exit", () => { if (!finished) finish({ text: "", status: "extraction_failed" }); });
  });
}

async function prepareMetadata(file, user, body = {}) {
  const extracted = await extractText(file.buffer, file.mimetype);
  return { subject: String(body.subject || "").trim().slice(0, 100), topic: String(body.topic || "").trim().slice(0, 200),
    // Shared teacher-published course resources preserve the existing access model.
    visibility: "shared", extractedText: extracted.text, textStatus: extracted.status };
}

async function learningDocuments(user, args = {}) {
  requireDatabase();
  const documents = [];
  const unavailable = [];
  const started = Date.now();
  let backfilled = 0;
  for (const bucketName of ["syllabus_files", "study_files"]) {
    const filter = materialAccess(user);
    if (args.subject) filter.$and = [{ $or: [{ "metadata.subject": new RegExp(escapeRegex(args.subject), "i") }, { filename: new RegExp(escapeRegex(args.subject), "i") }] }];
    const files = await mongoose.connection.db.collection(`${bucketName}.files`).find(filter).sort({ uploadDate: -1 }).limit(12).toArray();
    for (const file of files) {
      let text = file.metadata?.extractedText;
      // Existing uploads are backfilled from real PDF/text bytes on first use.
      // This is bounded; scanned pages are explicitly marked OCR-required.
      if (text === undefined && backfilled < 1 && Date.now() - started < 1500 && file.length <= 16 * 1024 * 1024 && (file.contentType === "application/pdf" || /^text\//.test(file.contentType))) {
        backfilled += 1;
        const chunks = []; let size = 0;
        const stream = new GridFSBucket(mongoose.connection.db, { bucketName }).openDownloadStream(file._id);
        const timer = setTimeout(() => stream.destroy(new Error("Material read deadline exceeded")), 8000);
        try {
          for await (const chunk of stream) {
            size += chunk.length;
            if (size > 16 * 1024 * 1024) throw new Error("Material exceeds extraction limit");
            chunks.push(chunk);
          }
          const extracted = await extractText(Buffer.concat(chunks), file.contentType);
          text = extracted.text;
          await mongoose.connection.db.collection(`${bucketName}.files`).updateOne({ _id: file._id }, { $set: { "metadata.extractedText": text, "metadata.textStatus": extracted.status } });
        } catch { unavailable.push({ title: file.filename, reason: "material_read_failed" }); }
        finally { clearTimeout(timer); stream.destroy(); }
      }
      if (text?.trim()) documents.push({ id: `${bucketName}:${file._id}`, title: file.filename,
        text: text.slice(0, MAX_TEXT), subject: file.metadata?.subject || "", topic: file.metadata?.topic || "",
        url: `/api/${bucketName === "study_files" ? "study" : "syllabus"}/${file._id}/preview` });
      else unavailable.push({ title: file.filename, reason: file.metadata?.textStatus || (text === undefined ? "legacy_backfill_pending" : "no_extractable_text") });
    }
  }
  return { documents, unavailable, boundedToRecent: 24 };
}
module.exports = { extractText, prepareMetadata, learningDocuments };
