/**
 * Link delivery.
 *
 * Two modes on purpose. 'log' writes the link to stdout, which means the login
 * works today with no mail provider and no signup — but anyone who can read the
 * deploy logs can log in, so it is for getting started and not for the revenue
 * manager. 'resend' sends a real mail and is the moment the log mode stops being
 * acceptable.
 */
export type MailMode = 'log' | 'resend'

export interface Mailer {
  send(to: string, link: string): Promise<void>
  mode: MailMode
}

export function makeMailer(env = process.env): Mailer {
  const key = env.RESEND_API_KEY
  const from = env.MAIL_FROM
  if (env.MAIL_MODE === 'resend' || (key && from)) {
    if (!key || !from) {
      throw new Error('mail mode resend needs RESEND_API_KEY and MAIL_FROM')
    }
    return {
      mode: 'resend',
      async send(to, link) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from, to,
            subject: 'Revenue Engine — Anmeldelink',
            text: `Anmeldelink, gültig 15 Minuten und einmal verwendbar:\n\n${link}\n`,
          }),
        })
        if (!res.ok) throw new Error(`resend failed: ${res.status}`)
      },
    }
  }
  return {
    mode: 'log',
    async send(to, link) {
      // Deliberately the whole link: in log mode this IS the delivery channel.
      console.log(`[login] link for ${to}: ${link}`)
    },
  }
}
