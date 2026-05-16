const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ========== DATABASE SETUP ==========
const db = new sqlite3.Database('./cloudline.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, price REAL, description TEXT, image_url TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT, room_number TEXT, product_id INTEGER, product_name TEXT,
    quantity INTEGER, total_price REAL, payment_method TEXT,
    delivery_method TEXT, special_message TEXT,
    scheduled_time TEXT, status TEXT, created_at TEXT, completed_at TEXT
  )`);
  // Insert default products if empty
  db.get(`SELECT COUNT(*) as cnt FROM products`, (err, row) => {
    if (row.cnt === 0) {
      db.run(`INSERT INTO products (name, price, description, image_url) VALUES 
        ('Classic Beef Burger', 35, '100% beef patty, cheese, lettuce, tomato, onion, Steers sauce', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300'),
        ('Burger + Juice Combo', 40, 'Burger + freshly squeezed orange juice', 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=300'),
        ('Double Cheeseburger', 55, 'Two beef patties, double cheese, caramelized onions', 'https://images.unsplash.com/photo-1553979459-d2229ba7433a?w=300')
      `);
    }
  });
});

// Email transporter (use your email)
// Email transporter using Resend SMTP
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

// WhatsApp helper
function sendWhatsAppMessage(toNumber, message) {
  // toNumber: 278... (South Africa format without '+')
  const encoded = encodeURIComponent(message);
  return `https://wa.me/${toNumber}?text=${encoded}`;
}

// ========== API ROUTES ==========
app.get('/api/products', (req, res) => {
  db.all(`SELECT * FROM products`, (err, rows) => res.json(rows));
});

app.post('/api/products', (req, res) => {
  const { name, price, description, image_url } = req.body;
  db.run(`INSERT INTO products (name, price, description, image_url) VALUES (?,?,?,?)`,
    [name, price, description, image_url], function(err) {
      res.json({ id: this.lastID });
    });
});

app.delete('/api/products/:id', (req, res) => {
  db.run(`DELETE FROM products WHERE id = ?`, req.params.id, () => res.json({ ok: true }));
});

app.post('/api/orders', (req, res) => {
  const { customerName, roomNumber, productId, productName, quantity, totalPrice,
          paymentMethod, deliveryMethod, specialMessage, scheduledTime } = req.body;
  const now = new Date().toISOString();
  db.run(`INSERT INTO orders (customer_name, room_number, product_id, product_name,
          quantity, total_price, payment_method, delivery_method, special_message,
          scheduled_time, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [customerName, roomNumber, productId, productName, quantity, totalPrice,
     paymentMethod, deliveryMethod, specialMessage || '', scheduledTime || null,
     'pending', now], function(err) {
       if (err) return res.status(500).json({ error: err.message });
       // Send email confirmation to admin and customer
       const subject = `New Order #${this.lastID} from ${customerName}`;
       const text = `Order: ${productName} x${quantity} | Total R${totalPrice}\nRoom: ${roomNumber}\nDelivery: ${deliveryMethod}\nNote: ${specialMessage}\nScheduled: ${scheduledTime || 'ASAP'}`;
       transporter.sendMail({ from: 'onboarding@resend.dev', to: 'kiddomeek4051@gmail.com', subject, text });
       transporter.sendMail({ from: 'onboarding@resend.dev', to: 'kiddomeek4051@gmail.com', subject: `Order Confirmation for ${customerName}`, text: `Your order #${this.lastID} received. We'll notify you when ready.` });
       res.json({ id: this.lastID, whatsappLink: sendWhatsAppMessage('2787208242', `New order: ${customerName} - ${productName} x${quantity}`) });
     });
});

app.get('/api/orders', (req, res) => {
  const status = req.query.status;
  let sql = `SELECT * FROM orders`;
  if (status) sql += ` WHERE status = '${status}'`;
  sql += ` ORDER BY created_at DESC`;
  db.all(sql, (err, rows) => res.json(rows));
});

app.put('/api/orders/:id/done', (req, res) => {
  db.run(`UPDATE orders SET status = 'completed', completed_at = datetime('now') WHERE id = ?`,
    req.params.id, () => res.json({ ok: true }));
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const month = today.slice(0,7);
  db.get(`SELECT SUM(total_price) as daily FROM orders WHERE status='completed' AND date(completed_at) = date('now')`, (err, dailyRow) => {
    db.get(`SELECT SUM(total_price) as monthly FROM orders WHERE status='completed' AND strftime('%Y-%m', completed_at) = ?`, month, (err2, monthRow) => {
      res.json({ dailyTotal: dailyRow?.daily || 0, monthlyTotal: monthRow?.monthly || 0 });
    });
  });
});

// CRON JOB: Send reminders 30 min before scheduled order
cron.schedule('* * * * *', () => {
  const now = new Date();
  const in30min = new Date(now.getTime() + 30*60000);
  db.all(`SELECT * FROM orders WHERE status='pending' AND scheduled_time IS NOT NULL`, (err, orders) => {
    orders.forEach(order => {
      const scheduled = new Date(order.scheduled_time);
      if (scheduled - now <= 30*60000 && scheduled > now) {
        const msg = `Reminder: Your order #${order.id} (${order.product_name}) is scheduled at ${order.scheduled_time}. We'll prepare soon!`;
        transporter.sendMail({ to: 'kiddomeek4051@gmail.com', subject: `Order reminder for ${order.customer_name}`, text: msg });
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
