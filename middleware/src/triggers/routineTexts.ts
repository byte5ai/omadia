/**
 * #2082 — what a routine's owner reads about its trigger: the renewal
 * question and why a routine stopped. In the instance's answer language
 * (`ai_disclosure_locale`, German unless English), dates in the instance's
 * proactive time zone.
 */

export type RoutineLang = 'de' | 'en';

export const routineLang = (raw: string | undefined): RoutineLang =>
  raw?.trim().toLowerCase().startsWith('en') ? 'en' : 'de';

/** Why the harness paused a routine (the trigger pause reasons). */
export type RoutinePauseCause = 'budget' | 'breaker_failures' | 'breaker_ineffective' | 'other';

const PAUSE: Record<RoutineLang, Record<RoutinePauseCause, string>> = {
  de: {
    budget: 'Die Routine wurde angehalten: ihr Budget ist aufgebraucht.',
    breaker_failures: 'Die Routine wurde angehalten: sie ist mehrmals hintereinander fehlgeschlagen.',
    breaker_ineffective: 'Die Routine wurde angehalten: ihre letzten Läufe hatten keine Wirkung.',
    other: 'Die Routine wurde angehalten.',
  },
  en: {
    budget: 'The routine was paused: its budget is used up.',
    breaker_failures: 'The routine was paused: it failed several times in a row.',
    breaker_ineffective: 'The routine was paused: its last runs had no effect.',
    other: 'The routine was paused.',
  },
};

export const routineTexts = {
  renewal(lang: RoutineLang, name: string, until: Date, timeZone: string): string {
    const date = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'de-DE', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(until);
    return lang === 'en'
      ? `Your routine "${name}" ends on ${date}. Should it go on? Just tell me "renew routine ${name}" and it runs for another period.`
      : `Deine Routine „${name}“ läuft am ${date} aus. Soll sie weiterlaufen? Sag mir einfach „Routine ${name} verlängern“, dann läuft sie einen weiteren Zeitraum.`;
  },
  expired(lang: RoutineLang): string {
    return lang === 'en'
      ? 'The routine has expired. Resume or renew it to run it again.'
      : 'Die Routine ist abgelaufen. Setze sie fort oder verlängere sie, damit sie wieder läuft.';
  },
  notScheduled(lang: RoutineLang, reason: string): string {
    return lang === 'en' ? `The routine could not be scheduled: ${reason}` : `Die Routine konnte nicht eingeplant werden: ${reason}`;
  },
  tooFrequent(lang: RoutineLang, minutes: number): string {
    return lang === 'en'
      ? `The routine runs more often than every ${String(minutes)} minutes; choose a slower schedule.`
      : `Die Routine läuft öfter als alle ${String(minutes)} Minuten; wähle einen langsameren Takt.`;
  },
  paused(lang: RoutineLang, cause: string): string {
    const known = cause === 'budget' || cause === 'breaker_failures' || cause === 'breaker_ineffective';
    return PAUSE[lang][known ? cause : 'other'];
  },
};
