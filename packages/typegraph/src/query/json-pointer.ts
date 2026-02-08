// JSON Pointer utilities and types.

export const MAX_JSON_POINTER_DEPTH = 5 as const;

export type JsonPointer = string & { readonly __jsonPointer: unique symbol };
export type JsonPointerSegment = string | number;
export type JsonPointerSegments = readonly JsonPointerSegment[];

type Depth = 0 | 1 | 2 | 3 | 4 | 5;

interface DepthDecrementMap {
  0: 0;
  1: 0;
  2: 1;
  3: 2;
  4: 3;
  5: 4;
}

type Decrement<Current extends Depth> = DepthDecrementMap[Current];

type NonNegativeIntegerString = Exclude<`${bigint}`, `-${string}`>;
type ObjectPointerKey<T> = Exclude<
  Extract<keyof T, string>,
  NonNegativeIntegerString
>;

type EncodeTilde<S extends string> =
  S extends `${infer Head}~${infer Tail}` ?
    `${EncodeTilde<Head>}~0${EncodeTilde<Tail>}`
  : S;

type EncodeSlash<S extends string> =
  S extends `${infer Head}/${infer Tail}` ?
    `${EncodeSlash<Head>}~1${EncodeSlash<Tail>}`
  : S;

type EncodePointerSegment<S extends string> = EncodeSlash<EncodeTilde<S>>;

type DecodePointerSegment<S extends string> =
  S extends `${infer Head}~1${infer Tail}` ?
    `${DecodePointerSegment<Head>}/${DecodePointerSegment<Tail>}`
  : S extends `${infer Head}~0${infer Tail}` ?
    `${DecodePointerSegment<Head>}~${DecodePointerSegment<Tail>}`
  : S;

type PointerForArray<T, Current extends Depth> =
  | `/${NonNegativeIntegerString}`
  | (Current extends 1 ? never
    : `/${NonNegativeIntegerString}${JsonPointerFor<T, Decrement<Current>>}`);

type PointerForObject<T, Current extends Depth> = {
  [K in ObjectPointerKey<T>]:
    | `/${EncodePointerSegment<K>}`
    | (Current extends 1 ? never
      : `/${EncodePointerSegment<K>}${JsonPointerFor<T[K], Decrement<Current>>}`);
}[ObjectPointerKey<T>];

export type JsonPointerFor<T, Current extends Depth = 5> =
  | ""
  | (Current extends 0 ? ""
    : T extends readonly (infer U)[] ? PointerForArray<U, Current>
    : never)
  | (Current extends 0 ? ""
    : T extends Record<string, unknown> ? PointerForObject<T, Current>
    : never);

type PointerSegmentsForArray<T, Current extends Depth> =
  | readonly [number]
  | (Current extends 1 ? readonly [number]
    : readonly [number, ...JsonPointerSegmentsFor<T, Decrement<Current>>]);

type PointerSegmentsForObject<T, Current extends Depth> = {
  [K in ObjectPointerKey<T>]:
    | readonly [K]
    | (Current extends 1 ? readonly [K]
      : readonly [K, ...JsonPointerSegmentsFor<T[K], Decrement<Current>>]);
}[ObjectPointerKey<T>];

export type JsonPointerSegmentsFor<T, Current extends Depth = 5> =
  | readonly []
  | (Current extends 0 ? readonly []
    : T extends readonly (infer U)[] ? PointerSegmentsForArray<U, Current>
    : never)
  | (Current extends 0 ? readonly []
    : T extends Record<string, unknown> ? PointerSegmentsForObject<T, Current>
    : never);

export type JsonPointerInput<T> =
  | JsonPointerFor<T>
  | JsonPointerSegmentsFor<T>
  | JsonPointer;

export type ResolveJsonPointer<T, Pointer extends string> =
  Pointer extends "" ? T
  : Pointer extends `/${infer Head}/${infer Tail}` ?
    ResolveJsonPointer<
      ResolvePointerSegment<T, DecodePointerSegment<Head>>,
      `/${Tail}`
    >
  : Pointer extends `/${infer Head}` ?
    ResolvePointerSegment<T, DecodePointerSegment<Head>>
  : unknown;

type ResolvePointerSegment<T, Segment extends string> =
  T extends readonly (infer U)[] ?
    Segment extends NonNegativeIntegerString ?
      U
    : unknown
  : T extends Record<string, unknown> ?
    Segment extends keyof T ?
      Segment extends NonNegativeIntegerString ?
        unknown
      : T[Segment]
    : unknown
  : unknown;

export type ResolveJsonPointerSegments<
  T,
  Segments extends readonly JsonPointerSegment[],
> =
  Segments extends readonly [] ? T
  : Segments extends readonly [infer Head, ...infer Tail] ?
    ResolveJsonPointerSegments<
      ResolvePointerSegment<T, SegmentToString<Head>>,
      Extract<Tail, readonly JsonPointerSegment[]>
    >
  : unknown;

type SegmentToString<Segment> =
  Segment extends number ? `${Segment}`
  : Segment extends string ? Segment
  : string;

export function jsonPointer(segments: JsonPointerSegments): JsonPointer {
  if (segments.length > MAX_JSON_POINTER_DEPTH) {
    throw new Error(
      `JSON Pointer exceeds max depth ${MAX_JSON_POINTER_DEPTH}: ${segments.length}`,
    );
  }

  if (segments.length === 0) {
    return "" as JsonPointer;
  }

  const encoded = segments.map((segment) => {
    if (segment === "-") {
      throw new Error(
        "JSON Pointer '-' segment is not allowed for query access",
      );
    }
    if (typeof segment === "number") {
      if (!Number.isInteger(segment) || segment < 0) {
        throw new Error(
          `JSON Pointer index must be a non-negative integer: ${segment}`,
        );
      }
      return segment.toString();
    }
    return encodeJsonPointerSegment(segment);
  });

  return `/${encoded.join("/")}` as JsonPointer;
}

function isJsonPointerSegments(
  input: unknown,
): input is readonly JsonPointerSegment[] {
  return Array.isArray(input);
}

export function normalizeJsonPointer<T>(
  input: JsonPointerInput<T>,
): JsonPointer {
  if (isJsonPointerSegments(input)) {
    return jsonPointer(input);
  }

  return assertJsonPointer(input);
}

export function parseJsonPointer(pointer: JsonPointer): readonly string[] {
  if (pointer === "") {
    return [];
  }

  const rawSegments = pointer.slice(1).split("/");
  return rawSegments.map((segment) => decodeJsonPointerSegment(segment));
}

export function joinJsonPointers(
  base: JsonPointer | undefined,
  relative: JsonPointer,
): JsonPointer {
  if (!base || base === "") {
    return relative;
  }
  if (relative === "") {
    return base;
  }

  const combinedSegments = [
    ...parseJsonPointer(base),
    ...parseJsonPointer(relative),
  ];
  return jsonPointer(combinedSegments);
}

function assertJsonPointer(pointer: string): JsonPointer {
  if (pointer !== "" && !pointer.startsWith("/")) {
    throw new Error("JSON Pointer must be empty or start with '/'");
  }

  const segments = pointer === "" ? [] : pointer.slice(1).split("/");
  if (segments.length > MAX_JSON_POINTER_DEPTH) {
    throw new Error(
      `JSON Pointer exceeds max depth ${MAX_JSON_POINTER_DEPTH}: ${segments.length}`,
    );
  }

  for (const segment of segments) {
    if (segment === "-") {
      throw new Error(
        "JSON Pointer '-' segment is not allowed for query access",
      );
    }
    if (!isValidPointerEncoding(segment)) {
      throw new Error(
        `Invalid JSON Pointer escape sequence in segment: ${segment}`,
      );
    }
  }

  return pointer as JsonPointer;
}

function encodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function isValidPointerEncoding(segment: string): boolean {
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] !== "~") {
      continue;
    }
    const next = segment[index + 1];
    if (next !== "0" && next !== "1") {
      return false;
    }
    index += 1;
  }
  return true;
}
