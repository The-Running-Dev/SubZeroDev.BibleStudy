import nodemailer from 'nodemailer';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>;
  close(): void;
}

// Any SMTP relay: Mailpit in development, a Gmail app password or a self-hosted Postfix in production.
// Timeouts are short so a hung relay fails the attempt (and schedules a retry) instead of stalling every queued code.
export function createSmtpTransport(smtpUrl: string, from: string): MailTransport {
  const transporter = nodemailer.createTransport({ url: smtpUrl, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000 });
  return {
    async send(mail) {
      await transporter.sendMail({ from, ...mail });
    },
    close() {
      transporter.close();
    },
  };
}

// Nodemailer reports the SMTP reply code as responseCode; 5xx is permanent, anything else may succeed later.
export function isPermanentFailure(error: unknown): boolean {
  const code = (error as { responseCode?: number } | null)?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}
