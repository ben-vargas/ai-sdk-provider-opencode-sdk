/**
 * Shared utilities for OpenCode tool/file part conversion.
 */

export interface OpencodeFileSource {
  type?: string;
  path?: string;
  uri?: string;
  [key: string]: unknown;
}

export interface OpencodeFilePartLike {
  id?: string;
  mime?: string;
  filename?: string;
  url?: string;
  source?: OpencodeFileSource;
}

export type FilePartPlanError = "missing-metadata" | "invalid-data-url";

interface FilePartPlanDocument {
  id: string;
  mediaType: string;
  title: string;
  filename?: string;
}

export interface FilePartPlan {
  sourceMetadata?: OpencodeFileSource;
  primary:
    | {
        type: "file";
        mediaType: string;
        data: string;
      }
    | {
        type: "source-url";
        id: string;
        url: string;
        title?: string;
      }
    | ({
        type: "source-document";
      } & FilePartPlanDocument);
  secondaryDocumentSource?: FilePartPlanDocument;
}

export function safeStringifyToolInput(
  input: unknown,
  onError?: (message: string) => void,
): string {
  try {
    return JSON.stringify(input) ?? "{}";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onError?.(message);
    return "{}";
  }
}

export function parseDataUrl(
  dataUrl: string,
): { mediaType: string; data: string } | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }

  const header = dataUrl.slice("data:".length, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);

  const headerTokens = header.split(";");
  const mediaTypeToken = headerTokens[0]?.trim();
  const mediaType =
    mediaTypeToken && mediaTypeToken.length > 0
      ? mediaTypeToken
      : "application/octet-stream";
  const isBase64 = headerTokens
    .slice(1)
    .some((token) => token.trim().toLowerCase() === "base64");

  if (isBase64) {
    return {
      mediaType,
      data: payload.replace(/\s+/g, ""),
    };
  }

  let decodedPayload: string;
  try {
    decodedPayload = decodeURIComponent(payload);
  } catch {
    return null;
  }

  return {
    mediaType,
    data: Buffer.from(decodedPayload, "utf8").toString("base64"),
  };
}

export function planFilePartConversion(part: OpencodeFilePartLike): {
  plan?: FilePartPlan;
  error?: FilePartPlanError;
} {
  if (!part.url || !part.mime) {
    return { error: "missing-metadata" };
  }

  const sourceMetadata = part.source;
  let primary: FilePartPlan["primary"] | undefined;
  let hasDocumentSource = false;

  if (part.url.startsWith("data:")) {
    const parsed = parseDataUrl(part.url);
    if (!parsed) {
      return { error: "invalid-data-url" };
    }

    primary = {
      type: "file",
      mediaType: parsed.mediaType,
      data: parsed.data,
    };
  } else if (
    part.url.startsWith("http://") ||
    part.url.startsWith("https://")
  ) {
    primary = {
      type: "source-url",
      id: part.id ?? part.url,
      url: part.url,
      ...(part.filename ? { title: part.filename } : {}),
    };
  } else {
    const filename = part.filename ?? part.url.split("/").pop() ?? "file";
    primary = {
      type: "source-document",
      id: part.id ?? part.url,
      mediaType: part.mime,
      title: filename,
      ...(filename ? { filename } : {}),
    };
    hasDocumentSource = true;
  }

  let secondaryDocumentSource: FilePartPlan["secondaryDocumentSource"];
  if (part.source && !hasDocumentSource) {
    const sourceType = part.source.type;
    if (
      sourceType === "file" ||
      sourceType === "symbol" ||
      sourceType === "resource"
    ) {
      const title =
        typeof part.source.path === "string"
          ? part.source.path
          : typeof part.source.uri === "string"
            ? part.source.uri
            : "source";

      secondaryDocumentSource = {
        id: `${part.id ?? "source"}-source`,
        mediaType: part.mime,
        title,
        ...(typeof part.source.path === "string"
          ? { filename: part.source.path }
          : {}),
      };
    }
  }

  return {
    plan: {
      sourceMetadata,
      primary,
      ...(secondaryDocumentSource ? { secondaryDocumentSource } : {}),
    },
  };
}
