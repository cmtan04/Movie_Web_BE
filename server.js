import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import client from "./src/config/mongoDB.config.js";
import chatRoutes from './src/routes/chatRoutes.js';
import pingRoutes from './src/routes/pingRoutes.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/chat', chatRoutes);
app.use('/ping', pingRoutes);
// Kết nối MongoDB khi khởi động server
async function startServer() {
    try {
        await client.connect();
        console.log("✓ Kết nối MongoDB thành công!");
    } catch (error) {
        console.error("✗ Lỗi kết nối MongoDB:", error);
        process.exit(1);
    }
}

const PORT = process.env.PORT || 3002;

startServer().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
    });
});
