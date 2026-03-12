async function run() {
  const base = "http://127.0.0.1:3000";
  const parseMaybeJson = async (response) => {
    const text = await response.text();
    try {
      return { body: JSON.parse(text), raw: text };
    } catch (_err) {
      return { body: null, raw: text };
    }
  };

  const getText = async (path) => {
    const response = await fetch(`${base}${path}`);
    if (!response.ok) {
      throw new Error(`GET ${path} failed with ${response.status}`);
    }
    return response.text();
  };

  const mangaHtml = await getText("/manga");
  const mangaMatch = mangaHtml.match(/href="\/manga\/([^"#?]+)"/i);
  if (!mangaMatch) {
    throw new Error("Cannot find manga URL from /manga page");
  }

  const slug = decodeURIComponent(mangaMatch[1]);
  const detailHtml = await getText(`/manga/${encodeURIComponent(slug)}`);
  const chapterRegex = new RegExp(`href=\\"\\/manga\\/${slug.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\/chapters\\/([^\\"#?]+)\\"`, "i");
  const chapterMatch = detailHtml.match(chapterRegex);
  if (!chapterMatch) {
    throw new Error(`Cannot find chapter URL from manga detail: ${slug}`);
  }

  const chapterNumber = decodeURIComponent(chapterMatch[1]);
  const chapterHtml = await getText(
    `/manga/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterNumber)}`
  );

  const thresholdMatch = chapterHtml.match(/data-reader-view-threshold="(\d+)"/i);
  const totalPagesMatch = chapterHtml.match(/data-reader-total-pages="(\d+)"/i);
  const trackUrlMatch = chapterHtml.match(/data-reader-view-track-url="([^"]+)"/i);
  if (!thresholdMatch || !totalPagesMatch || !trackUrlMatch) {
    throw new Error("Reader tracking attributes are missing from chapter page HTML");
  }

  const threshold = Number(thresholdMatch[1]);
  const totalPages = Number(totalPagesMatch[1]);
  const trackUrl = trackUrlMatch[1].replace(/&amp;/g, "&");

  const lowResponse = await fetch(`${base}${trackUrl}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ seenPages: Math.max(0, threshold - 1) })
  });
  const lowParsed = await parseMaybeJson(lowResponse);

  const okResponse = await fetch(`${base}${trackUrl}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ seenPages: threshold })
  });
  const okParsed = await parseMaybeJson(okResponse);

  console.log(
    JSON.stringify(
      {
        slug,
        chapterNumber,
        trackUrl,
        totalPages,
        threshold,
        lowStatus: lowResponse.status,
        lowResult: lowParsed.body,
        lowRaw: lowParsed.body ? null : lowParsed.raw.slice(0, 200),
        okStatus: okResponse.status,
        okResult: okParsed.body,
        okRaw: okParsed.body ? null : okParsed.raw.slice(0, 200)
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
