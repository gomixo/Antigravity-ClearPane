// Keep generated nodes stable so loading/failure never changes comment anchors.
export function loadImages(container, documentPath, fetchImage, afterLayout) {
  const controller = new AbortController();
  const { signal } = controller;
  const urls = new Set();
  const images = [...container.querySelectorAll('img[data-image-src]')];
  for (const image of images) {
    const status = image.nextElementSibling;
    image.hidden = true;
    image.removeAttribute('src');
    status.hidden = false;
    status.textContent = `${image.alt} · 正在加载图片…`;
    const current = () => !signal.aborted && image.isConnected;
    const failed = message => {
      if (!current()) return;
      image.hidden = true;
      status.hidden = false;
      status.textContent = `${image.alt} · ${message}`;
      afterLayout();
    };
    image.addEventListener('load', () => {
      if (!current()) return;
      image.hidden = false;
      status.hidden = true;
      afterLayout();
    }, { signal });
    image.addEventListener('error', () => failed('图片加载失败'), { signal });
    const src = image.dataset.imageSrc;
    if (/^https?:\/\//i.test(src)) {
      image.src = src;
    } else {
      void (async () => {
        try {
          const response = await fetchImage('/api/images/read', { method: 'POST',
            body: JSON.stringify({ documentPath, src }), signal });
          if (!response.ok) throw new Error((await response.json()).error || '图片读取失败');
          const blob = await response.blob();
          if (!current()) return;
          const url = URL.createObjectURL(blob);
          urls.add(url);
          image.src = url;
        } catch (error) {
          if (error.name !== 'AbortError') failed(error.message || '图片读取失败');
        }
      })();
    }
  }
  return () => {
    controller.abort();
    for (const url of urls) URL.revokeObjectURL(url);
    for (const image of images) image.removeAttribute('src');
  };
}
