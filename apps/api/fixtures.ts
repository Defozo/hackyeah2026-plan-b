export interface AiFact {
  id: string;
  sourceId: string;
  text: string;
  allowedForAi: true;
  status: "confirmed";
}
export const syntheticFacts: Record<string, AiFact[]> = {
  "shift-change": [
    {
      id: "intent",
      sourceId: "synthetic-input",
      text: "Mój cel: ruch poza ekranem.",
      allowedForAi: true,
      status: "confirmed",
    },
    {
      id: "plan",
      sourceId: "synthetic-input",
      text: "Zaplanowałem 30 minut treningu i 20 minut dojazdu.",
      allowedForAi: true,
      status: "confirmed",
    },
    {
      id: "change",
      sourceId: "synthetic-input",
      text: "Po zmianie grafiku mam 20 minut. Wybrałem znany spacer przy domu.",
      allowedForAi: true,
      status: "confirmed",
    },
  ],
  "care-packet": [
    {
      id: "history",
      sourceId: "synthetic-history",
      text: "W trzech podobnych sytuacjach wybrałem spacer. Dwa wykonania potwierdziłem, dla jednego nie ma odpowiedzi.",
      allowedForAi: true,
      status: "confirmed",
    },
    {
      id: "question",
      sourceId: "synthetic-question",
      text: "Chcę zapytać, jak odwzorować moje ustalenie na czas i rodzaj znanej aktywności.",
      allowedForAi: true,
      status: "confirmed",
    },
  ],
};
export const audioFixtureText =
  "Nie biegałem. Spacer trwał dwadzieścia minut, a odpoczynek trzydzieści. Nie zmieniałem leków. To są dane syntetyczne.";
