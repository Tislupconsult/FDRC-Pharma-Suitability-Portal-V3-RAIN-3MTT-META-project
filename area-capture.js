(function () {
  const roles = [
    { key: "ingredients", title: "Ingredient area", action: "Capture ingredient area from label" },
    { key: "indications", title: "Indication area", action: "Capture indication area from PIL" }
  ];
  const evidence = { ingredients: null, indications: null };
  const sourceFiles = { ingredients: null, indications: null };
  let activeRole = null;
  let image = null;
  let imageUrl = null;
  let imageLoadId = 0;
  let canvas = null;
  let selection = null;
  let dragStart = null;
  let screenshotInput = null;
  let dialog = null;
  let previousBodyOverflow = "";
  let restoreFocus = null;
  let portalCopyUpdated = false;

  window.pharmaAreaEvidence = evidence;

  const style = document.createElement("style");
  style.textContent = `
    .area-capture-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
    .area-capture-button{border:1px solid #bfdbfe;background:#eff6ff;color:#1e3a8a;border-radius:999px;padding:8px 12px;font:600 11px/1.2 Inter,system-ui,sans-serif;cursor:pointer}
    .area-capture-button:hover{background:#dbeafe}
    .area-capture-button:focus-visible,.area-modal button:focus-visible,.area-modal input:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}
    .area-capture-hint,.area-capture-saved{font:11px/1.5 Inter,system-ui,sans-serif;color:#64748b;margin:8px 0 0}
    .area-capture-saved{color:#166534}
    .area-modal-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.72);display:grid;place-items:center;padding:16px}
    .area-modal-backdrop[hidden]{display:none}
    .area-modal{background:#fff;width:min(960px,100%);max-height:94vh;overflow:auto;border-radius:16px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.3);font:13px/1.5 Inter,system-ui,sans-serif;color:#111827}
    .area-modal h2{font-size:18px;margin:0 0 6px}
    .area-modal p{margin:0 0 12px;color:#64748b}
    .area-modal-canvas-wrap{background:#0f172a;border-radius:10px;overflow:auto;text-align:center;max-height:65vh}
    .area-modal canvas{display:block;max-width:100%;max-height:65vh;width:auto;height:auto;margin:0 auto;touch-action:none;cursor:crosshair}
    .area-modal-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:14px}
    .area-modal-actions button,.area-modal input[type=file]{font:600 12px Inter,system-ui,sans-serif}
    .area-modal-actions button{border:1px solid #d1d5db;border-radius:999px;padding:9px 14px;background:#fff;cursor:pointer}
    .area-modal-actions button.primary{background:#006400;border-color:#006400;color:#fff}
    .area-modal-actions button:disabled{opacity:.45;cursor:not-allowed}
    .area-screenshot-picker{display:block;margin:14px 0;padding:16px;border:1px dashed #94a3b8;border-radius:10px;background:#f8fafc}
    .area-screenshot-picker[hidden]{display:none}
    @media(max-width:600px){.area-modal-backdrop{padding:8px}.area-modal{padding:14px}.area-modal-actions{flex-wrap:wrap}}
  `;
  document.head.appendChild(style);

  function ensureDialog() {
    if (dialog) return;

    dialog = document.createElement("div");
    dialog.className = "area-modal-backdrop";
    dialog.hidden = true;
    dialog.innerHTML = `
      <section class="area-modal" role="dialog" aria-modal="true" aria-labelledby="area-modal-title">
        <h2 id="area-modal-title"></h2>
        <p class="area-modal-instructions">Drag over the image to select only the text you want to focus on. You can adjust the selection before saving.</p>
        <label class="area-screenshot-picker" hidden>
          <b>No image preview is available for this document.</b><br>
          Choose a screenshot or photo of the relevant part of the page, then select the text area.
          <input class="area-screenshot-input" type="file" accept="image/png,image/jpeg,image/webp">
        </label>
        <div class="area-modal-canvas-wrap" hidden><canvas></canvas></div>
        <div class="area-modal-actions">
          <button type="button" data-action="close">Cancel</button>
          <button type="button" data-action="save" class="primary" disabled>Save selected area</button>
        </div>
      </section>`;
    document.body.appendChild(dialog);
    canvas = dialog.querySelector("canvas");
    screenshotInput = dialog.querySelector(".area-screenshot-input");
    dialog.querySelector('[data-action="close"]').addEventListener("click", closeDialog);
    dialog.querySelector('[data-action="save"]').addEventListener("click", saveCrop);
    dialog.addEventListener("click", event => {
      if (event.target === dialog) closeDialog();
    });
    screenshotInput.addEventListener("change", () => {
      const file = screenshotInput.files && screenshotInput.files[0];
      if (file) {
        loadImage(file);
        screenshotInput.value = "";
      }
    });
    canvas.addEventListener("pointerdown", startSelection);
    canvas.addEventListener("pointermove", updateSelection);
    canvas.addEventListener("pointerup", endSelection);
    canvas.addEventListener("pointercancel", endSelection);
  }

  function openDialog(role, file) {
    ensureDialog();
    restoreFocus = document.activeElement;
    previousBodyOverflow = document.body.style.overflow;
    activeRole = role;
    selection = null;
    dragStart = null;
    screenshotInput.value = "";
    dialog.querySelector("#area-modal-title").textContent = `Capture ${role.title.toLowerCase()}`;
    dialog.querySelector('[data-action="save"]').disabled = true;
    dialog.querySelector(".area-modal-instructions").textContent = file && file.type.startsWith("image/")
      ? "Drag over the image to select only the text you want to focus on. Adjust the selection before saving."
      : "Choose a screenshot or photo of the relevant part of the document, then drag over the text area to crop it.";
    dialog.hidden = false;
    document.body.style.overflow = "hidden";
    if (file && file.type.startsWith("image/")) {
      dialog.querySelector(".area-screenshot-picker").hidden = true;
      loadImage(file);
    } else {
      clearCanvas();
      dialog.querySelector(".area-screenshot-picker").hidden = false;
      dialog.querySelector(".area-modal-canvas-wrap").hidden = true;
    }
    dialog.querySelector('[data-action="close"]').focus();
  }

  function loadImage(file) {
    if (!file.type.startsWith("image/")) return;
    const loadId = ++imageLoadId;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    const nextImage = new Image();
    image = nextImage;
    imageUrl = URL.createObjectURL(file);
    nextImage.onload = () => {
      if (loadId !== imageLoadId || dialog.hidden) return;
      const scale = Math.min(1, 1800 / nextImage.naturalWidth, 1800 / nextImage.naturalHeight);
      canvas.width = Math.round(nextImage.naturalWidth * scale);
      canvas.height = Math.round(nextImage.naturalHeight * scale);
      selection = null;
      dialog.querySelector(".area-modal-canvas-wrap").hidden = false;
      dialog.querySelector(".area-screenshot-picker").hidden = true;
      dialog.querySelector('[data-action="save"]').disabled = true;
      drawCanvas();
    };
    nextImage.onerror = () => {
      if (loadId !== imageLoadId || dialog.hidden) return;
      dialog.querySelector(".area-screenshot-picker").hidden = false;
      dialog.querySelector(".area-modal-canvas-wrap").hidden = true;
      window.alert("The selected image could not be opened. Please choose a PNG, JPG, or WebP image.");
    };
    nextImage.src = imageUrl;
  }

  function clearCanvas() {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height))
    };
  }

  function startSelection(event) {
    if (!image || !canvas.width) return;
    canvas.setPointerCapture(event.pointerId);
    dragStart = canvasPoint(event);
    selection = { x: dragStart.x, y: dragStart.y, width: 0, height: 0 };
    drawCanvas();
  }

  function updateSelection(event) {
    if (!dragStart) return;
    const point = canvasPoint(event);
    selection = {
      x: Math.min(dragStart.x, point.x),
      y: Math.min(dragStart.y, point.y),
      width: Math.abs(point.x - dragStart.x),
      height: Math.abs(point.y - dragStart.y)
    };
    drawCanvas();
  }

  function endSelection() {
    if (!dragStart) return;
    dragStart = null;
    const valid = selection && selection.width >= 8 && selection.height >= 8;
    dialog.querySelector('[data-action="save"]').disabled = !valid;
  }

  function drawCanvas() {
    const context = canvas.getContext("2d");
    if (!context || !image) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (selection && selection.width > 0 && selection.height > 0) {
      context.fillStyle = "rgba(15,23,42,.48)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.clearRect(selection.x, selection.y, selection.width, selection.height);
      context.drawImage(
        image,
        selection.x * image.naturalWidth / canvas.width,
        selection.y * image.naturalHeight / canvas.height,
        selection.width * image.naturalWidth / canvas.width,
        selection.height * image.naturalHeight / canvas.height,
        selection.x, selection.y, selection.width, selection.height
      );
      context.strokeStyle = "#2563eb";
      context.lineWidth = Math.max(2, canvas.width / 500);
      context.strokeRect(selection.x, selection.y, selection.width, selection.height);
    }
  }

  function saveCrop() {
    if (!selection || !image || selection.width < 8 || selection.height < 8) return;
    const role = activeRole;
    const loadId = imageLoadId;
    const sourceImage = image;
    const cropCanvas = document.createElement("canvas");
    const sourceX = selection.x * sourceImage.naturalWidth / canvas.width;
    const sourceY = selection.y * sourceImage.naturalHeight / canvas.height;
    const sourceWidth = selection.width * sourceImage.naturalWidth / canvas.width;
    const sourceHeight = selection.height * sourceImage.naturalHeight / canvas.height;
    cropCanvas.width = Math.round(sourceWidth);
    cropCanvas.height = Math.round(sourceHeight);
    const cropContext = cropCanvas.getContext("2d");
    if (!cropContext) {
      window.alert("The selected area could not be saved because canvas is unavailable.");
      return;
    }
    cropContext.drawImage(
      sourceImage, sourceX, sourceY, sourceWidth, sourceHeight,
      0, 0, cropCanvas.width, cropCanvas.height
    );
    cropCanvas.toBlob(blob => {
      if (loadId !== imageLoadId || activeRole !== role || dialog.hidden) return;
      if (!blob) {
        window.alert("The selected area could not be saved. Please try again.");
        return;
      }
      const fileName = `${role.key}-area.png`;
      if (evidence[role.key]) URL.revokeObjectURL(evidence[role.key].imageUrl);
      evidence[role.key] = {
        file: new File([blob], fileName, { type: "image/png" }),
        imageUrl: URL.createObjectURL(blob),
        capturedAt: new Date().toISOString()
      };
      document.dispatchEvent(new CustomEvent("pharma:area-captured", {
        detail: { role: role.key, file: evidence[role.key].file }
      }));
      closeDialog();
      renderPanels();
    }, "image/png");
  }

  function closeDialog() {
    if (!dialog) return;
    dialog.hidden = true;
    document.body.style.overflow = previousBodyOverflow;
    imageLoadId++;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
    image = null;
    selection = null;
    dragStart = null;
    if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
    restoreFocus = null;
  }

  function renderPanels() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter(input => input.accept.includes(".pdf"));
    inputs.slice(0, 2).forEach((input, index) => {
      const role = roles[index];
      const host = input.parentElement;
      if (!host) return;
      let panel = host.querySelector(`[data-area-capture="${role.key}"]`);
      if (!panel) {
        panel = document.createElement("div");
        panel.dataset.areaCapture = role.key;
        panel.className = "area-capture-actions";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "area-capture-button";
        button.textContent = role.action;
        button.addEventListener("click", event => {
          event.stopPropagation();
          const sourceFile = sourceFiles[role.key] || input.files && input.files[0];
          openDialog(role, sourceFile);
        });
        panel.appendChild(button);
        const hint = document.createElement("p");
        hint.className = "area-capture-hint";
        panel.appendChild(hint);
        host.appendChild(panel);
      }
      const hint = panel.querySelector(".area-capture-hint");
      const hintText = sourceFiles[role.key]
        ? `Capture the ${role.key === "ingredients" ? "ingredient" : "indication"} area for ${sourceFiles[role.key].name}.`
        : `Upload a file, then capture its ${role.key === "ingredients" ? "ingredient" : "indication"} area.`;
      if (hint.textContent !== hintText) hint.textContent = hintText;
      const existing = evidence[role.key];
      const captureVersion = existing ? existing.capturedAt : "";
      if (panel.dataset.renderedCaptureAt === captureVersion) return;
      panel.dataset.renderedCaptureAt = captureVersion;
      panel.querySelector(".area-capture-result")?.remove();

      if (existing) {
        const result = document.createElement("div");
        result.className = "area-capture-result";
        const saved = document.createElement("div");
        saved.className = "area-capture-saved";
        saved.textContent = `${role.title} saved in this browser session. For PDFs, upload a screenshot. The demo prediction still uses simulated extraction.`;
        const preview = document.createElement("img");
        preview.src = existing.imageUrl;
        preview.alt = `Selected ${role.title.toLowerCase()}`;
        preview.style.cssText = "display:block;max-width:100%;max-height:140px;margin-top:8px;border:1px solid #d1d5db;border-radius:8px";
        const download = document.createElement("a");
        download.href = existing.imageUrl;
        download.download = existing.file.name;
        download.textContent = "Download selected area";
        download.style.cssText = "display:inline-block;margin-top:6px;color:#1d4ed8;font-size:11px";
        result.append(saved, preview, download);
        panel.appendChild(result);
      }
    });
    updatePortalCopy();
  }

  function clearEvidence(key) {
    const current = evidence[key];
    if (current) {
      URL.revokeObjectURL(current.imageUrl);
      evidence[key] = null;
    }
    renderPanels();
  }

  function roleForInput(input) {
    if (input.id === "labelFile") return roles[0];
    if (input.id === "pilFile") return roles[1];
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter(fileInput => fileInput.accept.includes(".pdf"));
    const index = inputs.indexOf(input);
    return roles[index];
  }

  function rememberUpload(input, file) {
    const role = roleForInput(input);
    if (!role) return;
    sourceFiles[role.key] = null;
    clearEvidence(role.key);
    if (file.size > 2 * 1024 * 1024 * 1024 || !/\.(pdf|jpe?g|png)$/i.test(file.name)) return;
    sourceFiles[role.key] = file;
    renderPanels();
  }

  document.addEventListener("change", event => {
    if (!(event.target instanceof HTMLInputElement) || event.target.type !== "file") return;
    const file = event.target.files && event.target.files[0];
    if (file) {
      rememberUpload(event.target, file);
      event.target.value = "";
    }
  });
  document.addEventListener("drop", event => {
    const dropZone = event.target instanceof Element && event.target.closest(".drop");
    const input = dropZone && dropZone.querySelector('input[type="file"]');
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (input && file) rememberUpload(input, file);
  });
  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.id === "resetBtn" || /^reset$/i.test(button.textContent.trim()) || /new (analysis|pair)/i.test(button.textContent)) {
      roles.forEach(role => {
        sourceFiles[role.key] = null;
        clearEvidence(role.key);
      });
    } else if (/^clear$/i.test(button.textContent.trim())) {
      const input = button.closest(".group")?.querySelector('input[type="file"]');
      const role = input && roleForInput(input);
      if (role) {
        sourceFiles[role.key] = null;
        clearEvidence(role.key);
      }
    }
  }, true);

  function updatePortalCopy() {
    if (portalCopyUpdated) return;
    const copyWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (copyWalker.nextNode()) {
      if (copyWalker.currentNode.nodeValue.includes("Built as single-file HTML/CSS/JS")) {
        copyWalker.currentNode.nodeValue = "Built with HTML/CSS/JS and area-capture.js • Ready for VS Code Live Server";
        portalCopyUpdated = true;
        break;
      }
    }
  }

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && dialog && !dialog.hidden) closeDialog();
  });
  new MutationObserver(renderPanels).observe(document.body, { childList: true, subtree: true });
  renderPanels();
})();
