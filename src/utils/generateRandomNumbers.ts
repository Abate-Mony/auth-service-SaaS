// import Product from "../models/productModel.js";
interface IgenerateRandomString {
  length?: number;
  type?: "number" | "string";
}
const charset =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateRandomString({
  length = 8,
  type = "string",
}: IgenerateRandomString = {}): number | string {
  // Define the character set

  // Create an empty string to store the result
  let result = "";

  // Loop for the desired length
  if (type == "string") {
    for (let i = 0; i < length; i++) {
      // Get a random index within the character set
      const randomIndex = Math.floor(Math.random() * charset.length);

      // Extract the character at the random index
      const randomChar = charset[randomIndex];

      // Append the character to the result string
      result += randomChar;
    }

    // Return the generated random string
    return result;
  } else {
    for (let i = 0; i < length; i++) {
      // Get a random index within the character set
      const randomIndex = Math.floor(Math.random() * 9) + 1;
      result += randomIndex;
    }
    // result = Number(result);
    console.log("this is the id in the function", result);
    return Number(result);
  }
}
async function generateUniqueRandomString({
  Model,
  filterType,
  type = "number",
  length = 4,
}: {
  Model: any;
  filterType?: string;
  type?: "number" | "string";
  length?: number;
}): Promise<number> {
  let randomString: string | number;
  let existingRecord: string | null = null;
  do {
    randomString = generateRandomString({ type: type, length: length });
    if (filterType) {
      existingRecord = await Model.findOne({
        [filterType ? filterType : "id"]: randomString,
      });
    }
  } while (existingRecord);
  if (type == "number") return Number(randomString);
  //   return randomString;
}

// Example usage
// const randomString = generateRandomString();
//   console.log(randomString); // Output: a random string of 6 characters
export {
  generateRandomString, generateUniqueRandomString as generateUniqueCharacter
};

