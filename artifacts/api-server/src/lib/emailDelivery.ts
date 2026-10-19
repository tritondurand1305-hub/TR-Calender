export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutgoingEmail): Promise<{ messageId?: string }>;
}

let provider: EmailProvider | null = null;

export function registerEmailProvider(value: EmailProvider): void {
  provider = value;
}

export function getEmailDeliveryStatus() {
  const configured =
    provider !== null &&
    Boolean(process.env.EMAIL_FROM_ADDRESS?.trim()) &&
    Boolean(process.env.EMAIL_FROM_NAME?.trim());
  const testRecipients = new Set(
    (process.env.EMAIL_TEST_RECIPIENTS ?? "")
      .split(",")
      .map((email) => email.trim().toLocaleLowerCase("en-CA"))
      .filter(Boolean),
  );
  const testingEnabled =
    process.env.NODE_ENV !== "production" &&
    process.env.EMAIL_TEST_MODE === "true" &&
    testRecipients.size > 0;
  const productionEnabled =
    process.env.NODE_ENV === "production" &&
    process.env.EMAIL_DELIVERY_ENABLED === "true";
  const sendingEnabled = configured && (testingEnabled || productionEnabled);

  return {
    configured,
    provider: provider?.name ?? null,
    automaticSendingEnabled: sendingEnabled,
    timezone: "America/Vancouver" as const,
    message: !provider
      ? "No email provider is connected. No confirmation or digest emails are sent."
      : !process.env.EMAIL_FROM_ADDRESS?.trim() ||
          !process.env.EMAIL_FROM_NAME?.trim()
        ? "Set a verified sender name and address before email can be sent."
        : !sendingEnabled
          ? "The provider is connected, but sending remains disabled until it is explicitly enabled and tested. Development test mode also requires an allow-listed recipient."
          : "Email delivery is enabled. Development sending is restricted to explicitly allow-listed test recipients.",
  };
}

export async function sendEmail(
  message: OutgoingEmail,
): Promise<{ messageId?: string }> {
  const status = getEmailDeliveryStatus();
  if (!provider || !status.configured || !status.automaticSendingEnabled) {
    throw new Error("EMAIL_DELIVERY_DISABLED");
  }
  if (process.env.NODE_ENV !== "production") {
    const allowedRecipients = new Set(
      (process.env.EMAIL_TEST_RECIPIENTS ?? "")
        .split(",")
        .map((email) => email.trim().toLocaleLowerCase("en-CA"))
        .filter(Boolean),
    );
    if (!allowedRecipients.has(message.to.trim().toLocaleLowerCase("en-CA"))) {
      throw new Error("EMAIL_TEST_RECIPIENT_NOT_ALLOWED");
    }
  }
  return provider.send(message);
}
