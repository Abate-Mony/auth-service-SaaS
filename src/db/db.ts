// cons mongoose = require("mongoose");
import mongoose from "mongoose";
mongoose.set("strictQuery", false);

interface IDataBase {
  uri: string;
  options: object;
}
export default class Database {
  uri: string;
  options: object;
  constructor({ uri, options }: IDataBase) {
    this.uri = uri;
    this.options = options;
  }

  async connect() {
    try {
      await mongoose.connect(this.uri, this.options);
      console.log(
        `Connected to database: ${mongoose.connection.db.databaseName}`
      );
    } catch (error) {
      throw error;
    }
  }

  async disconnect() {
    try {
      await mongoose.disconnect();
      console.log(
        `Disconnected from database: ${mongoose.connection.db.databaseName}`
      );
    } catch (error) {
      throw error;
    }
  }   
}

    export const database = ({ ...arg }: IDataBase) => new Database({ ...arg });
     