(function (root) {
  "use strict";
  let decoderPromise;
  const isHeic = file => /\.(heic|heif)$/i.test(String(file?.name || ""))
    || /^image\/(heic|heif)(-sequence)?$/i.test(String(file?.type || ""));
  const isImage = file => Boolean(file && (isHeic(file) || /^image\//i.test(file.type || "")));

  async function prepare(file) {
    if (!isHeic(file)) return file;
    if (file.size > 25 * 1024 * 1024) throw new Error("El HEIC supera los 25 MB.");
    if (!decoderPromise) {
      decoderPromise = import("./assets/vendor/heic-to/heic-to-1.6.6.js").catch(error => {
        decoderPromise = null;
        throw error;
      });
    }
    try {
      const { heicTo } = await decoderPromise;
      const image = await heicTo({ blob: file, type: "image/png" });
      if (!(image instanceof Blob) || !image.size) throw new Error("Empty image");
      return image;
    } catch {
      throw new Error("No pude convertir este HEIC. Probá otra foto o exportala como JPG.");
    }
  }
  root.NexoHeic = Object.freeze({ isHeic, isImage, prepare });
})(typeof window !== "undefined" ? window : globalThis);
