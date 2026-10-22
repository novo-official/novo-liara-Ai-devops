// Static, deterministic homepage: the expected output of the demo deployment.
export default function Home() {
  return (
    <main>
      <h1 id="title">سلام از دموی عامل دواپس لیارا</h1>
      <p id="marker">liara-agent-demo v1</p>
      <p>این صفحه ثابت است و به هیچ پایگاه‌داده، رمز یا سرویس بیرونی وابسته نیست.</p>
      <p>
        <a href="/health" style={{ color: "#7dd3fc" }}>/health</a>
      </p>
    </main>
  );
}
