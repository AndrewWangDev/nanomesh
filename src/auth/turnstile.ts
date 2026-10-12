export async function verifyTurnstile(token: string, secretKey: string): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append("secret", secretKey);
    formData.append("response", token);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData
    });

    const data: any = await res.json();
    return data.success === true;
  } catch (e) {
    return false;
  }
}
