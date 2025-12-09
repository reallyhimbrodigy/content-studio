document.addEventListener("DOMContentLoaded", () => {
  const buttons = [
    document.getElementById("connect-tiktok"),
    document.getElementById("connect-instagram"),
    document.getElementById("connect-youtube")
  ];

  async function launchPhyllo() {
    const res = await fetch("/api/phyllo/sdk-config", { credentials: "include" });
    if (!res.ok) return;
    const cfg = await res.json();

    const connect = window.PhylloConnect.initialize({
      userId: cfg.userId,
      token: cfg.token,
      environment: "sandbox",
      clientDisplayName: cfg.clientDisplayName
    });

    connect.open();
  }

  buttons.forEach(btn => {
    if (btn) btn.addEventListener("click", launchPhyllo);
  });
});
