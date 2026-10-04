import {
  Document,
  Page,
  Text,
  View,
  Font,
  StyleSheet,
  pdf,
} from "@react-pdf/renderer";
import type { CarePacket } from "@planb/domain";
import type { AppData } from "./vault";
import { fmt } from "./utils";
Font.register({
  family: "NotoSans",
  src: "/assets/fonts/NotoSans-Regular.ttf",
});
const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "NotoSans", color: "#182a46" },
  title: { fontSize: 24, marginBottom: 12 },
  section: { marginTop: 18, marginBottom: 8, fontSize: 14 },
  row: { marginBottom: 9 },
  small: { fontSize: 8, color: "#51627c" },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 40,
    right: 40,
    fontSize: 8,
  },
});
export function packetLines(data: AppData, p: CarePacket) {
  const source = (id: string) =>
    data.sources.find((s) => s.id === id)?.name ?? "Źródło usunięto";
  return [
    ...p.observationIds
      .map((id) => data.observations.find((x) => x.id === id))
      .filter((x) => !!x)
      .map((o) => ({
        id: o.id,
        text: `${o.metric}: ${o.value ?? "brak"} ${o.unit}`,
        source: `Pomiar / wpis: ${source(o.sourceId)} · ${fmt(o.start)}`,
      })),
    ...p.documentFactIds
      .map((id) => data.documentFacts.find((x) => x.id === id))
      .filter((x) => !!x)
      .map((f) => ({
        id: f.id,
        text: `${
          f.value
            .trimStart()
            .toLocaleLowerCase("pl")
            .startsWith(`${f.label.trim().toLocaleLowerCase("pl")}:`)
            ? ""
            : `${f.label}: `
        }${f.value}${f.unit && !f.value.includes(f.unit) ? ` ${f.unit}` : ""}`,
        source: `Potwierdzony fragment: ${source(f.sourceId)} · strona ${f.page}`,
      })),
    ...p.decisionIds
      .map((id) => data.decisions.find((x) => x.id === id))
      .filter((x) => !!x)
      .map((d) => ({
        id: d.id,
        text: `${d.kind === "rest" ? "Odpoczynek" : d.kind === "defer" ? "Odłożenie decyzji" : (d.candidate?.name ?? "Źródło usunięto")}. Przeszkoda: ${d.obstacle ?? "nie podano"}. Rezultat: ${({ done: "zrobiłem", different: "zrobiłem inaczej", not_done: "nie podjąłem działania", no_response: "brak odpowiedzi" } as const)[data.outcomes.find((o) => o.decisionId === d.id)?.status ?? "no_response"]}.${data.outcomes.find((o) => o.decisionId === d.id)?.note ? ` Obserwacja: ${data.outcomes.find((o) => o.decisionId === d.id)!.note}` : ""}`,
        source: `Samoopis użytkownika · ${fmt(d.createdAt)}`,
      })),
  ];
}
function Report({ data, packet: p }: { data: AppData; packet: CarePacket }) {
  return (
    <Document title="Plan B. Karta konsultacji" language="pl">
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Przed wizytą. Moja karta konsultacji</Text>
        {p.synthetic && <Text>DANE SYNTETYCZNE. Materiał demonstracyjny.</Text>}
        <Text style={styles.small}>
          Utworzono {fmt(p.createdAt)} · okres {fmt(p.start)} do {fmt(p.end)}
        </Text>
        <Text style={styles.section}>Cel rozmowy</Text>
        <Text>{p.goal || "Nie podano"}</Text>
        <Text style={styles.section}>Wybrane fakty</Text>
        {packetLines(data, p).map((l) => (
          <View key={l.id} style={styles.row} wrap={false}>
            <Text>{l.text}</Text>
            <Text style={styles.small}>{l.source}</Text>
          </View>
        ))}
        <Text style={styles.section}>Moje pytania</Text>
        {p.questions.map((q, i) => (
          <Text style={styles.row} key={i}>
            {i + 1}. {q}
          </Text>
        ))}
        <Text style={styles.footer} fixed>
          Plan B organizuje własne obserwacje. Dokument nie jest diagnozą ani
          zaleceniem medycznym.
        </Text>
      </Page>
    </Document>
  );
}
export async function buildPdf(data: AppData, packet: CarePacket) {
  return pdf(<Report data={data} packet={packet} />).toBlob();
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function buildHtml(data: AppData, p: CarePacket) {
  return `<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Karta konsultacji | Plan B</title><style>body{font:18px/1.6 system-ui;max-width:760px;margin:40px auto;padding:20px;color:#182a46}small{display:block;color:#51627c}li{margin-bottom:18px}@media print{body{margin:0}}</style><main><h1>Przed wizytą. Moja karta konsultacji</h1>${p.synthetic ? "<p><strong>Dane syntetyczne. Materiał demonstracyjny.</strong></p>" : ""}<p>Okres: ${escape(fmt(p.start))} do ${escape(fmt(p.end))}</p><h2>Cel rozmowy</h2><p>${escape(p.goal)}</p><h2>Wybrane fakty</h2><ul>${packetLines(
    data,
    p,
  )
    .map((l) => `<li>${escape(l.text)}<small>${escape(l.source)}</small></li>`)
    .join(
      "",
    )}</ul><h2>Moje pytania</h2><ol>${p.questions.map((q) => `<li>${escape(q)}</li>`).join("")}</ol><footer>Plan B organizuje własne obserwacje. Dokument nie jest diagnozą ani zaleceniem medycznym.</footer></main></html>`;
}
