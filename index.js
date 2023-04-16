require("dotenv").config();
const express = require("express");
const { Configuration, OpenAIApi } = require("openai");
const cors = require("cors");
const badWords = require("bad-words");

const app = express();
app.use(express.json());
app.use(cors()); // Add this line to enable CORS for all route

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);
const filter = new badWords();

const port = process.env.PORT || 5000;

app.post("/ask", async (req, res) => {
  const prompt = req.body.prompt;

  try {
    if (prompt == null) {
      throw new Error("Uh oh, no prompt was provided");
    }

    const response = await openai.createCompletion({
      model: "text-davinci-003",
      prompt,
      max_tokens: 500,
    });

    const completion = response.data.choices[0].text;
    const filteredCompletion = filter.clean(completion);

    return res.status(200).json({
      success: true,
      message: filteredCompletion,
    });
  } catch (error) {
    console.log(error.message);
  }
});

app.listen(port, () => console.log(`Server is running on port ${port}!!`));
