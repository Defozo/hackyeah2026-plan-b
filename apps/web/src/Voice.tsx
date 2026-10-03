import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2 } from "lucide-react";
import type { ViewProps } from "./App";
import { Button, DialogBox, Field } from "./components";
import { capabilities, postApi, type Capabilities } from "./api";
import { toBase64 } from "./vault";
import { errorText, now, uid } from "./utils";
export default function Voice({
  data,
  update,
  notify,
  onText,
}: { onText: (text: string) => void } & ViewProps) {
  const [open, setOpen] = useState(false),
    [caps, setCaps] = useState<Capabilities | null>(null),
    [blob, setBlob] = useState<Blob | null>(null),
    [url, setUrl] = useState(""),
    [recording, setRecording] = useState(false),
    [consent, setConsent] = useState(false),
    [transcript, setTranscript] = useState(""),
    [busy, setBusy] = useState(false),
    [duration, setDuration] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0),
    request = useRef<AbortController | null>(null);
  function clear() {
    generation.current++;
    request.current?.abort();
    recorder.current?.state === "recording" && recorder.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop());
    if (timer.current) clearTimeout(timer.current);
    setBlob(null);
    setTranscript("");
    setConsent(false);
    setRecording(false);
  }
  useEffect(() => {
    if (!blob) {
      setUrl("");
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  useEffect(
    () => () => {
      generation.current++;
      request.current?.abort();
      stream.current?.getTracks().forEach((t) => t.stop());
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function record() {
    try {
      clear();
      const token = generation.current;
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (token !== generation.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = s;
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      );
      const r = new MediaRecorder(s, type ? { mimeType: type } : undefined);
      recorder.current = r;
      const chunks: Blob[] = [];
      const started = Date.now();
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        if (token !== generation.current) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        setDuration(Math.min(60, (Date.now() - started) / 1000));
        setBlob(new Blob(chunks, { type: r.mimeType }));
        s.getTracks().forEach((t) => t.stop());
        setRecording(false);
      };
      r.start();
      setRecording(true);
      timer.current = setTimeout(
        () => r.state === "recording" && r.stop(),
        60000,
      );
    } catch {
      notify("Nie udało się włączyć mikrofonu. Możesz wpisać tekst ręcznie.");
    }
  }
  return (
    <>
      <Button
        className="secondary"
        onPress={async () => {
          setOpen(true);
          try {
            setCaps(await capabilities());
          } catch (e) {
            notify(errorText(e));
          }
        }}
      >
        <Mic size={17} /> Dyktuj notatkę
      </Button>
      {open && (
        <DialogBox
          title="Twoja notatka głosowa"
          onClose={() => {
            clear();
            setOpen(false);
          }}
        >
          <p>
            Do 60 sekund. Nagrywaj wyłącznie własną notatkę. Najpierw odsłuchaj
            nagranie, potem zdecyduj o wysyłce do Groq.
          </p>
          {data.profile.mode === "demo" ? (
            <>
              <p className="tag">Gotowe nagranie syntetyczne</p>
              {caps?.audioFixture && (
                <>
                  <audio controls src={caps.audioFixture.url} />
                  <p>{caps.audioFixture.text}</p>
                </>
              )}
            </>
          ) : (
            <>
              <div className="button-row">
                <Button
                  className="secondary"
                  isDisabled={recording}
                  onPress={() => void record()}
                >
                  <Mic size={17} /> Nagraj
                </Button>
                <Button
                  className="secondary"
                  isDisabled={!recording}
                  onPress={() => recorder.current?.stop()}
                >
                  <Square size={16} /> Zatrzymaj
                </Button>
                <Button className="text-button" onPress={clear}>
                  <Trash2 size={17} /> Usuń nagranie
                </Button>
              </div>
              {recording && (
                <p role="status">Nagrywanie, maksymalnie 60 sekund…</p>
              )}
              {url && <audio controls src={url} />}
            </>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />{" "}
            Odsłuchałem nagranie. Zgadzam się wysłać całe wybrane nagranie do
            Groq w celu transkrypcji.
          </label>
          <p className="caption">
            Dostawca otrzyma także ewentualne wypowiedziane dane osobowe.
            Poprawa transkryptu nie usuwa tego, co zostało przesłane.
          </p>
          <Button
            className="primary"
            isDisabled={
              busy ||
              !consent ||
              !caps?.transcription ||
              (data.profile.mode === "personal" &&
                (!caps.personalAiEnabled || !blob))
            }
            onPress={async () => {
              if (!caps) return;
              const token = generation.current;
              request.current = new AbortController();
              setBusy(true);
              try {
                await update({
                  ...data,
                  consents: [
                    ...data.consents,
                    {
                      id: uid(),
                      provider: "Groq",
                      purpose: "audio",
                      scope: [
                        data.profile.mode === "demo"
                          ? "polish-note"
                          : "selected-recording",
                      ],
                      grantedAt: now(),
                    },
                  ],
                });
                const result = await postApi(
                  "transcribe",
                  {
                    consent: {
                      provider: "groq",
                      purpose: "transcribe",
                      approved: true,
                    },
                    previewApproved: true,
                    ...(data.profile.mode === "demo"
                      ? { syntheticId: "polish-note" }
                      : {
                          audioBase64: toBase64(
                            new Uint8Array(await blob!.arrayBuffer()),
                          ),
                          mimeType: blob!.type.split(";")[0],
                          durationSeconds: duration,
                        }),
                  },
                  caps.csrfToken,
                  request.current.signal,
                );
                if (token !== generation.current) return;
                setTranscript(result.text ?? result.transcript ?? "");
              } catch (e) {
                notify(errorText(e));
              } finally {
                setBlob(null);
                setConsent(false);
                setBusy(false);
                request.current = null;
              }
            }}
          >
            {busy ? "Trwa transkrypcja…" : "Wyślij do transkrypcji"}
          </Button>
          {!caps?.transcription && (
            <p>
              Transkrypcja jest wyłączona lub usługa jest niedostępna. Tekst
              możesz wpisać poniżej.
            </p>
          )}
          {data.profile.mode === "personal" && !caps?.personalAiEnabled && (
            <p>Wysyłka własnych danych do AI jest wyłączona w konfiguracji.</p>
          )}
          <Field label="Popraw treść przed użyciem">
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
          </Field>
          <Button
            className="secondary"
            isDisabled={!transcript.trim()}
            onPress={() => {
              onText(transcript);
              clear();
              setOpen(false);
            }}
          >
            Użyj sprawdzonego tekstu
          </Button>
        </DialogBox>
      )}
    </>
  );
}
