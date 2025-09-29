import { pool } from './client';

export interface PhoneVerificationUpdate {
  telegramId: number;
  phone: string;
}

export const persistPhoneVerification = async ({
  telegramId,
  phone,
}: PhoneVerificationUpdate): Promise<void> => {
  await pool.query(
    `
      UPDATE users
      SET
        phone = $1,
        phone_verified = true,
        status = CASE
          WHEN status IN ('suspended', 'banned') THEN status
          WHEN status IN ('awaiting_phone', 'guest') THEN 'onboarding'
          WHEN status IS NULL THEN 'onboarding'
          ELSE status
        END,
        updated_at = now()
      WHERE tg_id = $2
    `,
    [phone, telegramId],
  );
};
