import express from 'express';
import { streamChat, clearChatHistory } from '../controllers/chatController.js';

const router = express.Router();

router.get('/stream', streamChat);
router.post('/clear', clearChatHistory);

export default router;
