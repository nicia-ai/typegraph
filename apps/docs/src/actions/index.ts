import { ActionError, defineAction } from "astro:actions";
import {
  NICIA_EMAIL_LIST_API_KEY,
  NICIA_EMAIL_LIST_API_URL,
} from "astro:env/server";
import { z } from "astro:schema";

import {
  EmailListAPIError,
  EmailListClient,
  STATUS_ALREADY_SUBSCRIBED,
} from "../lib/nicia-email-list-client";

const LIST_SLUG = "typegraph";
const MIN_SUBMISSION_TIME_MS = 2000;

export const server = {
  subscribe: defineAction({
    input: z.object({
      email: z.string().email("Please enter a valid email address."),
      website: z.string().optional(),
      renderedAt: z.number().optional(),
    }),
    handler: async ({ email, website, renderedAt }) => {
      const isHoneypotFilled = website !== undefined && website !== "";
      const isTooFast =
        renderedAt !== undefined &&
        Date.now() - renderedAt < MIN_SUBMISSION_TIME_MS;

      if (isHoneypotFilled || isTooFast) return { alreadySubscribed: false };

      const client = new EmailListClient({
        baseUrl: NICIA_EMAIL_LIST_API_URL,
        token: NICIA_EMAIL_LIST_API_KEY,
      });

      try {
        const result = await client.subscribe(LIST_SLUG, email);
        return {
          alreadySubscribed: result.status === STATUS_ALREADY_SUBSCRIBED,
        };
      } catch (error) {
        if (error instanceof EmailListAPIError) {
          throw new ActionError({
            code: "BAD_REQUEST",
            message: error.body.details ?? error.message,
          });
        }
        throw new ActionError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong. Please try again.",
        });
      }
    },
  }),
};
