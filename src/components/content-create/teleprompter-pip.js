export async function openTeleprompterPictureInPicture(sourceWindow) {
  if (!sourceWindow.documentPictureInPicture?.requestWindow) {
    throw new Error('Always-on-top mode needs a supported desktop browser, such as Chrome or Edge. You can keep reading here or open a regular window.');
  }
  const floating = await sourceWindow.documentPictureInPicture.requestWindow({width:480,height:700});
  try {
    const source = sourceWindow.document;
    const target = floating.document;
    target.title = 'Teleprompter · Compel';
    target.documentElement.lang = source.documentElement.lang || 'en';
    const base = target.createElement('base');
    base.href = sourceWindow.location.href;
    target.head.appendChild(base);
    for (const stylesheet of source.querySelectorAll('style,link[rel="stylesheet"]')) {
      const copy = stylesheet.cloneNode(true);
      if (stylesheet.tagName === 'LINK') copy.href = stylesheet.href;
      target.head.appendChild(copy);
    }
    target.body.className = source.body.className;
    target.body.style.margin = '0';
    target.body.style.overflow = 'hidden';
    return floating;
  } catch (error) {
    floating.close();
    throw error;
  }
}
