export const metadata = { title: "Liara Agent Demo", description: "Deterministic demo page" };

export default function RootLayout({ children }) {
  return (
    <html lang="fa" dir="rtl">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem", background: "#0b1220", color: "#e6edf7" }}>{children}</body>
    </html>
  );
}
