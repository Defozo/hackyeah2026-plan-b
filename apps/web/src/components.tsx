import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Dialog,
  Modal,
  ModalOverlay,
  Heading,
} from "react-aria-components";
import { X } from "lucide-react";
export { Button };
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function DialogBox({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const receive = (event: Event) =>
      setMessage((event as CustomEvent<string>).detail);
    window.addEventListener("planb-notice", receive);
    return () => window.removeEventListener("planb-notice", receive);
  }, []);
  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="overlay"
    >
      <Modal className="modal">
        <Dialog>
          <div className="dialog-heading">
            <Heading slot="title">{title}</Heading>
            <Button
              aria-label="Zamknij"
              className="icon-button"
              onPress={onClose}
            >
              <X size={20} />
            </Button>
          </div>
          {message && (
            <div role="status" className="notice">
              {message}
            </div>
          )}
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
