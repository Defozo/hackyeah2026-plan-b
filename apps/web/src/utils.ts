import { DateTime } from "luxon";
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export function fmt(value: string, zone = "Europe/Warsaw") {
  return DateTime.fromISO(value, { zone })
    .setLocale("pl")
    .toFormat("ccc, d LLL · HH:mm");
}
export function time(value: string, zone = "Europe/Warsaw") {
  return DateTime.fromISO(value, { zone }).toFormat("HH:mm");
}
export function localInput(value: string, zone = "Europe/Warsaw") {
  return DateTime.fromISO(value, { zone }).toFormat("yyyy-MM-dd'T'HH:mm");
}
export function fromLocal(value: string, zone = "Europe/Warsaw") {
  const d = DateTime.fromISO(value, { zone });
  if (
    !d.isValid ||
    d.toFormat("yyyy-MM-dd'T'HH:mm") !== value ||
    d.getPossibleOffsets().length > 1
  )
    throw Error(
      "Czas jest niejednoznaczny lub nie istnieje przy zmianie czasu. Wybierz inną godzinę.",
    );
  return d.toUTC().toISO()!;
}
export function download(
  name: string,
  content: Blob | string,
  type = "text/plain",
) {
  const url = URL.createObjectURL(
    content instanceof Blob ? content : new Blob([content], { type }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export const errorText = (err: unknown) =>
  err instanceof Error
    ? err.message
    : "Nie udało się wykonać operacji. Spróbuj ponownie.";
