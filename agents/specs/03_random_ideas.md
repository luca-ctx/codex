Here are some ideas of features that could improve the performance of the agent:

1. Continous Context Cleaning 
some type of hook step that proactively cleans the context window with each turn. Instead of waiting for a large compaction step (which destroys a lot of valuable recent context that may have to be re-discovered), we can extract junk from the context window continuously.

For example, if i am the agent and i run `pnpm test` and it prints out like 10k tokens of logs and ultimately it just says "all tests pass" - i dont really need the model to remember all of the test stdout, i just need it to know that it ran the tests and it passed.

In the same way that an agent can currently patch a file, we want to be able to actively patch the context window history.

We would be invoking a new agent which says:
"Look at the entire context window below and consider what the agent is working on. your job is to continuously clean context by giving us a patch command to remove unnecessary context. it is critical that you dont remove any useful information, so be relatively conservative with what you choose to remove. its even fine to choose to not remove anything during this turn. but if you see some content that is obviously useless junk, you can make a patch to remove it. here is an example {show example of some context with some junk stdout; then how to form the patch}. Important things to NOT patch away include: 1. important docs and resources that have been read; 2. messages from the human developer; 3. source code files from the pertinent areas being worked on. Just know that once you remove this context, it is impossible to get it back (except in the case of reading files, those files could be re-read), so be relatively conservative with what you remove"

We could basically try adding this capability, testing it out to make sure it works (and inspect which types of things it tries to remove), try to break it, and then ultimately give it an e2e test to see if it can get larger-scale tasks done faster and more effectively because we are better utilizing the small context window.