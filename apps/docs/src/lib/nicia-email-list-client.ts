/**
 * Nicia Email List API Client
 *
 * Self-contained, fetch-only client for the public email list API.
 * Compatible with Cloudflare Workers, browsers, and Node 18+.
 */

const STATUS_SUBSCRIBED = "subscribed" as const;
const STATUS_ALREADY_SUBSCRIBED = "already_subscribed" as const;
const STATUS_UNSUBSCRIBED = "unsubscribed" as const;

// -- Types ------------------------------------------------------------------

interface Subscriber {
  id: string;
  listId: string;
  email: string;
  metadata: Record<string, unknown> | null;
  subscribedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface SubscribeResultNew {
  status: typeof STATUS_SUBSCRIBED;
  subscriber: Subscriber;
}

interface SubscribeResultExisting {
  status: typeof STATUS_ALREADY_SUBSCRIBED;
}

type SubscribeResult = SubscribeResultNew | SubscribeResultExisting;

interface CheckResult {
  subscribed: boolean;
}

interface UnsubscribeResult {
  status: typeof STATUS_UNSUBSCRIBED;
}

interface EmailListClientOptions {
  /** Base URL of the API (no trailing slash). */
  baseUrl: string;
  /** Bearer token with appropriate scopes. */
  token: string;
}

interface APIErrorBody {
  error: string;
  details?: string;
}

// -- Errors -----------------------------------------------------------------

class EmailListAPIError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: APIErrorBody,
  ) {
    super(body.error);
    this.name = "EmailListAPIError";
  }
}

// -- Client -----------------------------------------------------------------

class EmailListClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: EmailListClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
  }

  async subscribe(slug: string, email: string): Promise<SubscribeResult> {
    return this.post<SubscribeResult>(`/v1/lists/${enc(slug)}/subscribe`, {
      email,
    });
  }

  async check(slug: string, email: string): Promise<CheckResult> {
    return this.post<CheckResult>(`/v1/lists/${enc(slug)}/check`, { email });
  }

  async unsubscribe(slug: string, email: string): Promise<UnsubscribeResult> {
    return this.post<UnsubscribeResult>(`/v1/lists/${enc(slug)}/unsubscribe`, {
      email,
    });
  }

  private async post<T>(path: string, body: { email: string }): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    const json: unknown = await response.json();

    if (!response.ok) {
      throw new EmailListAPIError(response.status, json as APIErrorBody);
    }

    return json as T;
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

export {
  EmailListAPIError,
  EmailListClient,
  STATUS_ALREADY_SUBSCRIBED,
  STATUS_SUBSCRIBED,
  STATUS_UNSUBSCRIBED,
};
export type {
  APIErrorBody,
  CheckResult,
  EmailListClientOptions,
  Subscriber,
  SubscribeResult,
  SubscribeResultExisting,
  SubscribeResultNew,
  UnsubscribeResult,
};
