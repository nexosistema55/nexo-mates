window.NexoMedia = (() => {
  const maxBytes = 5 * 1024 * 1024;
  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("nexo-product-media", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("videos");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function access(id, blob) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("videos", blob ? "readwrite" : "readonly");
        const request = blob ? tx.objectStore("videos").put(blob, id) : tx.objectStore("videos").get(id);
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("No se pudo guardar el video."));
      });
    } finally { db.close(); }
  }
  async function optimize(file, progress = () => {}) {
    if (!file || !file.type.startsWith("video/")) throw new Error("Elegí un archivo de video.");
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    let stream;
    let recorder;
    let timer;
    let frame;
    try {
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error("El navegador no puede abrir este video. Probá con MP4."));
      });
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 30.1) throw new Error("El video debe durar como máximo 30 segundos.");
      const mime = ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8"].find((type) => window.MediaRecorder?.isTypeSupported(type));
      if (!mime || !HTMLCanvasElement.prototype.captureStream) throw new Error("Este navegador no permite comprimir videos. Abrí el sistema en Chrome o Edge.");
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight), 720 / Math.min(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(2, Math.floor(video.videoWidth * scale / 2) * 2);
      canvas.height = Math.max(2, Math.floor(video.videoHeight * scale / 2) * 2);
      const ctx = canvas.getContext("2d");
      stream = canvas.captureStream(24);
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1000000 });
      const chunks = [];
      const output = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = () => reject(new Error("No se pudo comprimir el video."));
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
        video.onended = () => { if (recorder.state !== "inactive") recorder.stop(); };
        timer = setTimeout(() => {
          reject(new Error("La compresión tardó demasiado. Probá con otro video."));
          if (recorder.state !== "inactive") recorder.stop();
        }, 45000);
      });
      // Only the canvas is recorded: no audio track is retained.
      const draw = () => {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        progress(Math.min(99, Math.round(video.currentTime / video.duration * 100)));
        frame = requestAnimationFrame(draw);
      };
      await video.play();
      draw();
      recorder.start(500);
      const blob = await output;
      if (!blob.size || blob.size > maxBytes) throw new Error("El resultado supera 5 MB. Usá un video más corto.");
      progress(100);
      return blob;
    } finally {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      video.pause();
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stream?.getTracks().forEach((track) => track.stop());
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  }
  return { get: (id) => access(id), put: (id, blob) => access(id, blob), optimize };
})();
