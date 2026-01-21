import dotenv from 'dotenv';
dotenv.config();
import { MongoClient } from "mongodb";

const client = new MongoClient(`mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASSWORD}@filmdata.jdggyyc.mongodb.net/?appName=FilmData`)

export default client;