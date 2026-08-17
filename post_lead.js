const body = {
  "first_name": "Test",
  "last_name": "Lead",
  "company": "Acme Corp",
  "linkedin_url": "https://linkedin.com/in/testlead",
  "website": "acme.com",
  "email": "test@acme.com",
  "email_status": "VERIFIED",
  "location": "UK",
  "hook": "Hi Test, loved your work at Acme Corp."
};
fetch("http://34.121.143.37:5678/webhook-test/lead-finished", {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify(body)
}).then(res => res.text()).then(console.log).catch(console.error);
