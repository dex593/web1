import { useEffect, useState } from "react";
import { fetchForumLinkLabels } from "@/lib/forum-api";

type ForumRichContentProps = {
  html: string;
  className?: string;
};

const toSafeText = (value: unknown): string => String(value == null ? "" : value).trim();

const parseComparablePath = (value: string): string => {
  const raw = toSafeText(value);
  if (!raw || typeof window === "undefined") return "";

  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return "";
    }

    const normalizedPath = (parsed.pathname || "/").replace(/\/+$/, "") || "/";
    return `${normalizedPath}${parsed.search || ""}`.toLowerCase();
  } catch (_error) {
    return "";
  }
};

const shouldReplaceAnchorText = (anchor: HTMLAnchorElement, hrefValue: string): boolean => {
  if (anchor.querySelector("img,svg,video,picture")) {
    return false;
  }

  const text = toSafeText(anchor.textContent);
  if (!text) return true;

  const comparableHref = parseComparablePath(hrefValue);
  const comparableText = parseComparablePath(text);

  if (comparableHref && comparableText && comparableHref === comparableText) {
    return true;
  }

  if (/^(https?:\/\/|www\.|\/)/i.test(text)) {
    return true;
  }

  return false;
};

const extractCandidateUrls = (html: string): string[] => {
  if (!html || typeof DOMParser !== "function") {
    return [];
  }

  const parsed = new DOMParser().parseFromString(html, "text/html");
  const anchors = Array.from(parsed.body.querySelectorAll<HTMLAnchorElement>("a[href]"));
  if (!anchors.length) return [];

  return Array.from(
    new Set(
      anchors
        .map((anchor) => toSafeText(anchor.getAttribute("href") || anchor.href || ""))
        .filter(Boolean)
    )
  );
};

export const ForumRichContent = ({ html, className }: ForumRichContentProps) => {
  const [renderedHtml, setRenderedHtml] = useState<string>(toSafeText(html) ? String(html) : "");

  useEffect(() => {
    const source = String(html || "");
    setRenderedHtml(source);

    const candidateUrls = extractCandidateUrls(source);
    if (!candidateUrls.length || typeof DOMParser !== "function") {
      return;
    }

    let cancelled = false;

    const applyLabels = async () => {
      try {
        const labels = await fetchForumLinkLabels(candidateUrls);
        if (cancelled) return;

        const labelEntries = Object.entries(labels || {}).filter((entry) => toSafeText(entry[0]) && toSafeText(entry[1]));
        if (!labelEntries.length) {
          return;
        }

        const labelMap = new Map<string, string>(labelEntries.map(([url, label]) => [toSafeText(url), toSafeText(label)]));
        const parsed = new DOMParser().parseFromString(source, "text/html");
        const anchors = Array.from(parsed.body.querySelectorAll<HTMLAnchorElement>("a[href]"));
        if (!anchors.length) return;

        let changed = false;
        anchors.forEach((anchor) => {
          const hrefValue = toSafeText(anchor.getAttribute("href") || anchor.href || "");
          if (!hrefValue) return;

          const nextLabel = toSafeText(labelMap.get(hrefValue));
          if (!nextLabel) return;
          if (!shouldReplaceAnchorText(anchor, hrefValue)) return;
          if (toSafeText(anchor.textContent) === nextLabel) return;

          anchor.textContent = nextLabel;
          changed = true;
        });

        if (!changed || cancelled) {
          return;
        }

        setRenderedHtml(parsed.body.innerHTML);
      } catch (_error) {
        // ignore label failures, keep original content
      }
    };

    void applyLabels();

    return () => {
      cancelled = true;
    };
  }, [html]);

  return <div className={className} dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
};
