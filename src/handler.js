require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DB_CONNECTION_STRING,
});

exports.handler = async (event) => {
  try {
    const { cpf } = JSON.parse(event.body);

    if (!cpf || !/^\d{11}$/.test(cpf)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "CPF inválido" }),
      };
    }

    const result = await pool.query(
      "SELECT status FROM clientes WHERE cpf = $1",
      [cpf],
    );

    if (result.rows.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Cliente não encontrado" }),
      };
    }

    const status = result.rows[0].status;

    const token = jwt.sign({ cpf, status }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    return { statusCode: 200, body: JSON.stringify({ token }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Erro interno" }) };
  }
};
