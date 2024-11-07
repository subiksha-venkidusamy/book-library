const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const app = express();
const port = 5000;
const SECRET_KEY = "your_secret_key"; // Use an environment variable in production

// Middleware
app.use(cors());
app.use(express.json());

// MySQL connection setup
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "subi@180205_",
  database: "library",
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err.stack);
    return;
  }
  console.log("Connected to the database.");
});

// Routes for getting books
app.get("/api/books", (req, res) => {
  db.query("SELECT * FROM books", (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// User signup
app.post("/api/users/signup", async (req, res) => {
  const { name, email, password, role } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.query(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
      [name, email, hashedPassword, role],
      (err) => {
        if (err) return res.status(400).json({ error: "Signup failed" });
        res.json({ message: "User registered successfully" });
      }
    );
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// User login
app.post("/api/users/login", (req, res) => {
  const { email, password, role } = req.body;
  db.query(
    "SELECT * FROM users WHERE email = ? AND role = ?",
    [email, role],
    async (err, results) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (results.length === 0)
        return res.status(401).json({ error: "Invalid credentials" });

      const user = results[0];
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword)
        return res.status(401).json({ error: "Invalid credentials" });

      const token = jwt.sign(
        { id: user.user_id, role: user.role },
        SECRET_KEY,
        { expiresIn: "1h" }
      );
      res.json({ message: "Login successful", token, userId: user.user_id });
    }
  );
});

// Checkout book with PDF receipt generation
app.post("/api/books/checkout", async (req, res) => {
  const { userId, bookId } = req.body;
  try {
    const [book] = await db
      .promise()
      .query("SELECT count FROM books WHERE book_id = ?", [bookId]);
    if (book.length === 0 || book[0].count < 1)
      return res.status(400).json({ message: "Book not available" });

    await db
      .promise()
      .query("UPDATE books SET count = count - 1 WHERE book_id = ?", [bookId]);

    const checkoutDate = new Date();
    const dueDate = new Date(checkoutDate);
    dueDate.setDate(dueDate.getDate() + 15);

    const checkoutCode = Math.floor(100000 + Math.random() * 900000);

    await db
      .promise()
      .query(
        `INSERT INTO bookcheckouts (user_id, book_id, checkout_date, due_date, fine_amount, receipt_id) VALUES (?, ?, ?, ?, 0, ?)`,
        [userId, bookId, checkoutDate, dueDate, checkoutCode]
      );

    const doc = new PDFDocument();
    const receiptPath = path.join(__dirname, "receipts", `${checkoutCode}.pdf`);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    doc.pipe(fs.createWriteStream(receiptPath));
    doc.fontSize(25).text("Book Checkout Receipt", { align: "center" });
    doc.moveDown();
    doc.fontSize(18).text(`Receipt ID: ${checkoutCode}`);
    doc.text(`User ID: ${userId}`);
    doc.text(`Book ID: ${bookId}`);
    doc.text(`Checkout Date: ${checkoutDate.toLocaleDateString()}`);
    doc.text(`Due Date: ${dueDate.toLocaleDateString()}`);
    doc.end();

    res.json({
      message: "Book checked out successfully",
      checkoutCode,
      receiptPath: `/api/receipts/${checkoutCode}`,
    });
  } catch (error) {
    res.status(500).json({ error: "Error during checkout" });
  }
});

// Serve receipt PDF for download
app.use("/receipts", express.static(path.join(__dirname, "receipts")));

// Serve receipt PDF for download
app.get("/api/receipts/:receiptId", (req, res) => {
  const { receiptId } = req.params;
  const receiptPath = path.join(__dirname, "receipts", `${receiptId}.pdf`);

  console.log("Looking for receipt at:", receiptPath); // Log the path for debugging

  fs.promises
    .access(receiptPath, fs.constants.F_OK) // Check if the file exists
    .then(() => {
      // File exists, send it for download
      res.download(receiptPath, `${receiptId}.pdf`, (err) => {
        if (err) {
          console.error("Error downloading the file:", err);
          res.status(500).send("Error downloading the file.");
        }
      });
    })
    .catch((err) => {
      // File does not exist
      console.log("Receipt not found at:", receiptPath); // Log if not found
      res.status(404).send("Receipt not found.");
    });
});



// Scheduled cron job to update fines for overdue books
cron.schedule("0 0 * * *", async () => {
  try {
    await db.promise().query(`
      UPDATE bookcheckouts
      SET fine_amount = DATEDIFF(NOW(), due_date) * 10
      WHERE return_date IS NULL AND NOW() > due_date
    `);
    console.log("Fines updated for overdue books");
  } catch (error) {
    console.error("Error updating fines:", error);
  }
});

// Return book API
app.post("/api/books/return", async (req, res) => {
  const { userId, bookId } = req.body;
  try {
    const [checkout] = await db
      .promise()
      .query(
        "SELECT checkout_id, due_date FROM bookcheckouts WHERE user_id = ? AND book_id = ? AND return_date IS NULL",
        [userId, bookId]
      );

    if (!checkout[0])
      return res
        .status(400)
        .json({ error: "No active checkout found for this book" });

    const { checkout_id, due_date } = checkout[0];
    const today = new Date();
    const fine =
      today > new Date(due_date)
        ? Math.floor((today - new Date(due_date)) / (1000 * 60 * 60 * 24)) * 10
        : 0;

    await db
      .promise()
      .query(
        "UPDATE bookcheckouts SET return_date = NOW() WHERE checkout_id = ?",
        [checkout_id]
      );
    await db
      .promise()
      .query("UPDATE books SET count = count + 1 WHERE book_id = ?", [bookId]);

    res.json({ message: "Book returned successfully", fine });
  } catch (error) {
    res
      .status(500)
      .json({ error: "An error occurred while returning the book" });
  }
});

app.get("/api/users/profile/:userId", (req, res) => {
  const { userId } = req.params;

  db.query(
    `
    SELECT users.name, users.email, SUM(bookcheckouts.fine_amount) AS total_fine,
           JSON_ARRAYAGG(
             JSON_OBJECT(
               'book_id', books.book_id,
               'title', books.title,
               'author', books.author,
               'due_date', bookcheckouts.due_date,
               'fine_amount', bookcheckouts.fine_amount
             )
           ) AS books_checked_out
    FROM users
    LEFT JOIN bookcheckouts ON users.user_id = bookcheckouts.user_id
    LEFT JOIN books ON bookcheckouts.book_id = books.book_id
    WHERE users.user_id = ? AND bookcheckouts.return_date IS NULL
    GROUP BY users.user_id
    `,
    [userId],
    (err, results) => {
      if (err) {
        console.error("Error fetching profile details:", err.message);
        return res.status(500).json({ error: "Database error" });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json(results[0]);
    }
  );
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
