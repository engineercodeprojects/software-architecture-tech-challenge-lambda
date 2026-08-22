const { handler } = require("../src/handler");

test("retorna erro se CPF for inválido", async () => {
  const event = { body: JSON.stringify({ cpf: "123" }) };
  const response = await handler(event);
  expect(response.statusCode).toBe(400);
});
